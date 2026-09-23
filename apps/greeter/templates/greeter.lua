-- /etc/greetd/greeter.lua — the greeter compositor.
--
-- Boot-level, runs as user "greeter" on VT 1 (spawned by greetd via
-- start-hyprland -- -c /etc/greetd/greeter.lua). Mirrors the main
-- hyprland.lua's frost/blur parameters so the login screen matches the
-- desktop, but contains NO user-session autostarts. On successful login the
-- app spawns /etc/greetd/greeter-handoff.sh which SIGKILLs this compositor
-- (no `hyprctl dispatch exit` — the handoff owns teardown so the last
-- rendered frame freezes on the framebuffer until the user session paints
-- over it).
--
-- Lua config surface (Hyprland 0.56): hl.config / hl.on / hl.exec_cmd /
-- hl.bind / hl.layer_rule. `hyprctl keyword` is parser-locked on 0.56 — layer
-- rules and binds MUST be declared here, never via hyprctl.

hl.config({
    input = {
        kb_layout = "us",
        -- Greeter should be touch-friendly (login on the convertible).
        touchpad = {
            tap_to_click = true,
            natural_scroll = true,
        },
    },
    general = {
        gaps_out = 0,
        gaps_in = 0,
        border_size = 0,
    },
    decoration = {
        rounding = 0,
        shadow = {
            enabled = false,
        },
        blur = {
            enabled = true,
            size = 3,
            passes = 3,
            new_optimizations = true,
        },
    },
    cursor = {
        no_hardware_cursors = false,
        -- Hyprland 0.56 hides the pointer on touch by default, and this machine
        -- folds into tablet mode where the touchpad is suspended: a touch is then
        -- the only input it can produce, and only a POINTER MOTION event clears
        -- the hide flag — a folded convertible never generates one, so the
        -- pointer would stay invisible for the rest of the login.
        hide_on_touch = false,
        hide_on_tablet = false,
        hide_on_key_press = false,
        inactive_timeout = 0,
    },
    -- Keep the boot console clean: no Hyprland startup-log spam on tty1
    -- before the greeter maps.
    debug = {
        enable_stdout_logs = false,
    },
})

-- Frosted-glass blur for the TINSHELL greeter (namespace "greeter", same frost
-- parameters as the desktop apps). NOT in hyprland.lua — the greeter runs
-- in THIS compositor, not the user's.
hl.layer_rule({ match = { namespace = "greeter" }, blur = true, ignore_alpha = 0.2 })

-- Hardware brightness keys, so the screen can be dimmed on a fresh boot or a
-- resume with NOBODY logged in. This compositor is up before any user session
-- exists, so hyprland.lua's XF86MonBrightness binds are not loaded here, and
-- nothing else maps the keys on this VT: the TINSHELL login window is a
-- keyboard-EXCLUSIVE layer surface, so an unmapped key reaches the card and is
-- dropped. brightnessctl writes the backlight through logind
-- (Session.SetBrightness on this session), which logind authorizes for the
-- owner of the ACTIVE seat session — true while the greeter holds VT 1 — since
-- the sysfs attribute itself is root-only. Same binary and step as
-- hyprland.lua's brightness binds, so the key behaves identically here and in
-- the session. The binary is named by ABSOLUTE path: this compositor's
-- environment is minimal (HOME is unset), and a bind that cannot resolve its
-- binary at a login screen fails with no visible symptom. hyprland.lua's own
-- brightness binds keep the bare name — that config runs inside a full user
-- session.
local brightnessStep = "5%"
-- `repeating` re-runs the bind while the key is held — the same flag the
-- session's brightness binds in hyprland.lua carry — so a held key keeps
-- stepping instead of stopping after the first press.
hl.bind("XF86MonBrightnessUp", hl.dsp.exec_cmd("/usr/bin/brightnessctl set " .. brightnessStep .. "+"), { repeating = true })
hl.bind("XF86MonBrightnessDown", hl.dsp.exec_cmd("/usr/bin/brightnessctl set " .. brightnessStep .. "-"), { repeating = true })

hl.on("hyprland.start", function()
    -- Greeter wallpaper layer FIRST — covers the logout-respawn gap (the
    -- compositor's default background would otherwise flash until the TINSHELL
    -- window maps). The retry loop gives awww-daemon a moment to bind its
    -- socket before awww img can reach it.
    hl.exec_cmd("/bin/sh -c 'awww-daemon >/tmp/greeter-awww.log 2>&1 & for i in 1 2 3 4 5 6 7 8 9 10; do awww img /etc/greetd/tinshell-greeter/wallpaper.png --transition-type none && break; sleep 0.2; done'")
    -- Run the bundled TINSHELL greeter. On successful login the app spawns
    -- /etc/greetd/greeter-handoff.sh which SIGKILLs this compositor — no
    -- `hyprctl dispatch exit` here, the handoff owns teardown.
    hl.exec_cmd("/bin/sh -c '/etc/greetd/tinshell-greeter.sh'")
end)
