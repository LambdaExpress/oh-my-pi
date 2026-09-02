---
name: herdr-windows-zig-build
description: 在 Windows 上构建 Herdr 原生 Ghostty 依赖并规避 Zig 跨盘断言失败
---

## 适用场景

在 Windows 上从源码构建 Herdr，尤其是仓库与 Zig 安装位于不同盘符，且 `libghostty-vt` 构建出现 `std.fs.path.isAbsolute(child_cwd_rel)` 断言失败时。

## 步骤

1. 使用 Herdr 固定的 Zig `0.15.2`。
2. 确保传给 Cargo build script 的 Zig 入口与 Herdr 仓库位于同一盘符。当前仓库在 `D:` 时，使用 `D:/tools/zig-0.15.2/zig.exe`；该目录的 `lib` 必须指向对应 Zig 安装的 `lib`。
3. 将 Zig 全局缓存也放在同一盘：
   - `ZIG=D:\tools\zig-0.15.2\zig.exe`
   - `ZIG_GLOBAL_CACHE_DIR=D:\tools\zig-cache-0.15.2`
4. Windows 类型检查使用 `cargo check --bin herdr`。不要用 `cargo check --tests` 作为 Windows 门禁，因为仓库包含使用 `std::os::unix` 的 Unix-only 集成测试。
5. 定向测试使用 `cargo test --locked --bin herdr <filter>`；lint 使用 `cargo clippy --bin herdr --locked --target x86_64-pc-windows-msvc -- -D warnings`；发布构建使用 `cargo build --release --locked`。

## 原因

Zig 0.15.2 在该 vendored 构建的 Windows 跨盘工作目录处理中会把绝对路径传到要求相对路径的内部流程。同盘 Zig 入口和缓存避免触发该路径断言。
