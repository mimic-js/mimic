(module
  (import "wasi_snapshot_preview1" "args_sizes_get"
    (func $args_sizes_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "args_get"
    (func $args_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "environ_sizes_get"
    (func $environ_sizes_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "environ_get"
    (func $environ_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit"
    (func $proc_exit (param i32) (result i32)))

  (memory (export "memory") 1)
  (data (i32.const 2048) "stderr=observed\0a")

  (func (export "_start")
    (drop (call $args_sizes_get (i32.const 0) (i32.const 4)))
    (drop (call $args_get (i32.const 64) (i32.const 128)))
    (i32.store (i32.const 16) (i32.const 128))
    (i32.store (i32.const 20) (i32.load (i32.const 4)))
    (drop (call $fd_write (i32.const 1) (i32.const 16) (i32.const 1) (i32.const 32)))

    (drop (call $environ_sizes_get (i32.const 8) (i32.const 12)))
    (drop (call $environ_get (i32.const 512) (i32.const 1024)))
    (i32.store (i32.const 24) (i32.const 1024))
    (i32.store (i32.const 28) (i32.load (i32.const 12)))
    (drop (call $fd_write (i32.const 1) (i32.const 24) (i32.const 1) (i32.const 36)))

    (i32.store (i32.const 40) (i32.const 2048))
    (i32.store (i32.const 44) (i32.const 16))
    (drop (call $fd_write (i32.const 2) (i32.const 40) (i32.const 1) (i32.const 48)))
    (drop (call $proc_exit (i32.const 7))))
)
