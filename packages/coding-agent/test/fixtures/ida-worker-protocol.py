"""Run the real worker protocol without loading the licensed IDA SDK."""

import importlib.util
import io
import json
import signal
import sys
import types

# Only the SDK import surface is replaced; dispatch, exec, framing and signals
# use the production worker and the subprocess's real file descriptors.
for name in (
    "idapro", "ida_domain", "ida_domain.database", "ida_domain.xrefs",
    "ida_auto", "ida_bytes", "ida_funcs", "ida_hexrays", "ida_idaapi",
    "ida_idp", "ida_lines", "ida_loader", "ida_nalt", "ida_name",
    "ida_segment", "ida_typeinf", "ida_ua", "ida_xref", "idautils",
):
    sys.modules[name] = types.ModuleType(name)
sys.modules["ida_domain"].Database = object
sys.modules["ida_domain.database"].IdaCommandOptions = object
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
