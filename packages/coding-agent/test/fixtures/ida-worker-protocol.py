"""Run the real worker protocol without loading the licensed IDA SDK."""

import importlib.util
import io
import json
import signal
import sys
import tempfile
import types

# Only the SDK import surface is replaced; dispatch, exec, framing and signals
# use the production worker and the subprocess's real file descriptors.
for name in (
    "idapro", "ida_domain", "ida_domain.database", "ida_domain.strings", "ida_domain.xrefs",
    "ida_auto", "ida_bytes", "ida_funcs", "ida_hexrays", "ida_idaapi",
    "ida_idp", "ida_lines", "ida_loader", "ida_nalt", "ida_name",
    "ida_segment", "ida_typeinf", "ida_ua", "ida_xref", "idautils",
):
    sys.modules[name] = types.ModuleType(name)
sys.modules["ida_domain"].Database = object
sys.modules["ida_domain.database"].IdaCommandOptions = object
sys.modules["ida_domain.strings"].StringListConfig = types.SimpleNamespace
sys.modules["ida_domain.strings"].StringType = types.SimpleNamespace(C=0, C_16=1, C_32=2)
sys.modules["ida_domain.xrefs"].XrefType = object
sys.modules["ida_idp"].IDB_Hooks = type("IDB_Hooks", (), {})
sys.modules["ida_hexrays"].Hexrays_Hooks = type("Hexrays_Hooks", (), {})

mode = sys.argv[2]
if mode != "posix" and hasattr(signal, "pthread_sigmask"):
    del signal.pthread_sigmask

spec = importlib.util.spec_from_file_location("ida_worker", sys.argv[1])
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
protocol = worker._proto


class InterruptedOutput:
    def __init__(self, target, fail_flush=False):
        self.target = target
        self.fail_flush = fail_flush
        self.flushed = False

    def write(self, data):
        middle = len(data) // 2
        self.target.write(data[:middle])
        signal.raise_signal(signal.SIGINT)
        self.target.write(data[middle:])
        return len(data)

    def flush(self):
        signal.raise_signal(signal.SIGINT)
        if self.fail_flush:
            raise BrokenPipeError("protocol pipe closed")
        self.target.flush()
        self.flushed = True


if mode == "requests":
    worker._proto = InterruptedOutput(protocol)
    worker.main()
elif mode.startswith("strings-"):
    # File bytes are real; the SDK model exposes only the analyzer's saved list,
    # which omits CLR metadata even after a rebuild.
    data = bytearray(195072)
    data[:2] = b"MZ"
    data[0x3C:0x40] = (0x80).to_bytes(4, "little")
    data[0x80:0x84] = b"PE\0\0"
    definitions = []

    def put(offset, text, encoding="utf-8", internal_type=0, defined=False):
        raw = text.encode(encoding) + "\0".encode(encoding)
        data[offset:offset + len(raw)] = raw
        if defined:
            definitions.append(types.SimpleNamespace(
                address=0x400000 + offset, length=len(raw), internal_type=internal_type,
            ))

    put(0x100, "Native message", defined=True)
    put(0x140, "约束来源名称", "utf-16-le", 1, defined=True)
    put(0x180, "Source 😀 value", "utf-32-le", 2, defined=True)
    put(0x1C0, "ID", defined=True)
    put(0x240, "éééé")
    put(0x260, "ééééé")
    put(0x280, "日本語の名前😀")
    data[0x300:0x302] = b"\xff\xfe"
    put(0x302, "ReadableName")
    put(0x340, "\u0085VisibleAfterControl")
    put(142655, "VRCConstraintSource")
    put(163386, "RegisterConstraint")
    put(163405, "UnregisterConstraint")
    managed = mode.startswith("strings-managed-")
    listed = (
        definitions.copy() if mode == "strings-native"
        else definitions[:1] if mode == "strings-managed-partial"
        else []
    )

    class Strings:
        def get_all(self):
            return iter(listed)

        def rebuild(self, config):
            # Already-defined native strings honor the requested widths/minimum.
            # CLR metadata is not present in this analyzer's extracted list.
            if not managed:
                listed[:] = [
                    item for item in definitions
                    if item.internal_type in config.string_types
                    and len(string_contents(item.address, item.length, item.internal_type).decode("utf-8")) >= config.min_len
                ]

    def string_contents(ea, length, internal_type):
        encoding = ("utf-8", "utf-16-le", "utf-32-le")[internal_type]
        offset = ea - 0x400000
        return bytes(data[offset:offset + length]).decode(encoding).rstrip("\0").encode("utf-8")

    worker.DB = types.SimpleNamespace(architecture="cli" if managed else "metapc", strings=Strings())
    worker.ida_bytes.get_strlit_contents = string_contents
    worker.ida_idaapi.BADADDR = 0xFFFFFFFFFFFFFFFF
    # One name is outside all mapped regions; the other file offsets have real EAs.
    worker.ida_loader.get_fileregion_ea = (
        lambda offset: worker.ida_idaapi.BADADDR if offset == 163405 else 0x400000 + offset
    )
    with tempfile.TemporaryDirectory(prefix="ida-worker-strings-") as directory:
        source_path = directory + "/managed.dll"
        with open(source_path, "wb") as source:
            source.write(data)
        worker.ida_nalt.get_input_file_path = lambda: source_path
        result = {
            **worker._rpc_view({"kind": "strings"}),
            "items": worker.strings(),
            "constraints": worker.strings("constraint"),
        }
elif mode.startswith("pseudocode-"):
    class Function:
        start_ea = 0x1000
        end_ea = 0x1003

    class Failure:
        code = 0
        errea = 0xFFFFFFFFFFFFFFFF

        def desc(self):
            return "cannot convert to microcode"

    function = Function()
    managed = mode in ("pseudocode-managed", "pseudocode-managed-supported", "pseudocode-badarch")
    worker.ida_funcs.func_t = Function
    worker.ida_funcs.get_func_name = lambda _: "Example::Read" if managed else "read_value"
    worker.ida_idaapi.BADADDR = 0xFFFFFFFFFFFFFFFF
    worker.ida_hexrays.hexrays_failure_t = Failure
    worker.ida_hexrays.MERR_BADARCH = -1
    worker.ida_hexrays.MERR_CANCELED = -2
    worker.idautils.FuncItems = lambda _: range(function.start_ea, function.end_ea)
    disassembly = ("ldc.i4.1", "stloc.0", "ret") if managed else ("mov eax, 1", "nop", "ret")
    worker.ida_lines.generate_disasm_line = lambda ea, _: disassembly[ea - function.start_ea]
    worker.ida_lines.tag_remove = lambda text: text.replace("\x01", "").replace("\x02", "")

    def init_decompiler():
        # idalib can reset SIGINT when it initializes a decompiler, even on failure.
        signal.signal(signal.SIGINT, signal.SIG_DFL)
        return mode not in ("pseudocode-managed", "pseudocode-unavailable")

    def decompile_function(func, hf=None, decomp_flags=0):
        # Model the actual SWIG typemap: failure object second, integer flags third.
        if not isinstance(func, Function) or not isinstance(hf, Failure) or not isinstance(decomp_flags, int):
            raise TypeError("in method 'decompile_func', argument 2 of type 'hexrays_failure_t *'")
        signal.signal(signal.SIGINT, signal.SIG_DFL)
        if mode == "pseudocode-interrupt":
            raise KeyboardInterrupt()
        if mode in ("pseudocode-failure", "pseudocode-badarch", "pseudocode-canceled"):
            hf.code = (
                worker.ida_hexrays.MERR_BADARCH if mode == "pseudocode-badarch"
                else worker.ida_hexrays.MERR_CANCELED if mode == "pseudocode-canceled"
                else -3
            )
            hf.errea = function.start_ea + 1
            return None
        return types.SimpleNamespace(get_pseudocode=lambda: [
            types.SimpleNamespace(line="\x01int read_value(void)\x02"),
            types.SimpleNamespace(line="{"),
            types.SimpleNamespace(line="    return 1;"),
            types.SimpleNamespace(line="}"),
        ])

    worker.ida_hexrays.init_hexrays_plugin = init_decompiler
    worker.ida_hexrays.decompile_func = decompile_function
    worker.DB = types.SimpleNamespace(
        architecture="cli" if managed else "metapc",
        # Reproduce the legacy Domain wrapper's positional-argument mismatch.
        pseudocode=types.SimpleNamespace(decompile=lambda func: decompile_function(func, 0)),
    )
    try:
        result = worker._rpc_view({"kind": "pseudocode", "target": function})
    except KeyboardInterrupt:
        result = {"interrupted": True}
    result["sigint_restored"] = signal.getsignal(signal.SIGINT) is signal.default_int_handler
elif mode == "restore":
    received = []
    signal.signal(signal.SIGINT, lambda *_: received.append("SIGINT"))
    worker._proto = InterruptedOutput(io.StringIO())
    worker._send({"id": 1})
    signal.raise_signal(signal.SIGINT)
    after_success = len(received)
    worker._proto = InterruptedOutput(io.StringIO(), fail_flush=True)
    try:
        worker._send({"id": 2})
    except BrokenPipeError as error:
        failure = str(error)
    else:
        raise AssertionError("flush failure did not propagate")
    signal.raise_signal(signal.SIGINT)
    result = {
        "after_success": after_success,
        "after_failure": len(received),
        "failure": failure,
    }
elif mode == "posix":
    delivered = []

    def on_interrupt(*_):
        delivered.append({
            "frame": json.loads(worker._proto.target.getvalue()),
            "flushed": worker._proto.flushed,
        })

    signal.signal(signal.SIGINT, on_interrupt)
    original = signal.pthread_sigmask(signal.SIG_SETMASK, {signal.SIGTERM})
    try:
        worker._proto = InterruptedOutput(io.StringIO())
        worker._send({"id": 1})
        after_first = signal.pthread_sigmask(signal.SIG_BLOCK, set())
        signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT})
        worker._proto = InterruptedOutput(io.StringIO())
        worker._send({"id": 2})
        after_second = signal.pthread_sigmask(signal.SIG_BLOCK, set())
        deferred = len(delivered) == 1
        signal.pthread_sigmask(signal.SIG_SETMASK, {signal.SIGTERM})
        result = {
            "delivered": delivered,
            "preserved_unrelated": after_first == {signal.SIGTERM},
            "preserved_blocked": after_second == {signal.SIGTERM, signal.SIGINT},
            "deferred_preblocked": deferred,
        }
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, original)
else:
    raise ValueError(f"unknown fixture mode: {mode}")

protocol.write(json.dumps(result) + "\n")
protocol.flush()
