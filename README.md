<h1 align="center">yasc — Yet Another Server Client</h1>

<p align="center">
  A <strong>terminal-only control panel for Minecraft Java servers</strong> — no web
  dashboard, no Docker, no daemon. It runs your server jar as-is and wraps the
  whole thing in a polished TUI with rounded borders: console, players,
  <code>server.properties</code>, files/configs, plugins/mods, live telemetry,
  and one-click public access, all a Tab away.
</p>

<p align="center">
  <img alt="Node.js ≥18" src="https://img.shields.io/badge/Node.js-%E2%89%A518-339933?logo=nodedotjs&logoColor=white">
  <img alt="JavaScript" src="https://img.shields.io/badge/JavaScript-F7DF1E?logo=javascript&logoColor=black">
  <img alt="Zero dependencies" src="https://img.shields.io/badge/dependencies-0-2ea44f">
  <img alt="Minecraft Java Edition" src="https://img.shields.io/badge/Minecraft-Java%20Edition-62B47A">
  <img alt="Platform: terminal" src="https://img.shields.io/badge/platform-terminal-1f2937?logo=windowsterminal&logoColor=white">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-yellow"></a>
</p>

```
╭──────────────────────────────────────────────────────────────────────────────────────────────╮
│ ▘ yasc   ● running          Survival SMP  ·  paper 1.21.11           up 1h02m05s   02:17:37    │
╰──────────────────────────────────────────────────────────────────────────────────────────────╯
 1·Console  2·Players  3·Properties  4·Files  5·Plugins  6·Network  7·Server     Tab/F1-7 switch
╭─ Console ───────────────────────────────────────────────────────────────╮╭─ Status ──────────╮
│ [12:00:00] [Server thread/INFO]: Done (5.231s)! For help, type "help"    ││ State   running   │
│ [12:00:05] [Server thread/INFO]: Notch joined the game                   ││ Uptime  1h02m05s  │
│ > say welcome to the server                                              ││ Players 2/20      │
│ [12:00:11] [Server thread/WARN]: Can't keep up! Is the server overloaded?││                   │
│ [12:00:14] [Server thread/INFO]: <Notch> hey all                         ││ Performance       │
│                                                                          ││ TPS     19.9      │
│                                                                          ││ MSPT    6.4       │
│                                                                          ││ RAM     1.3G      │
│                                                                          ││                   │
│                                                                          ││ CPU     42%       │
│                                                                          ││ Plugins 4         │
│                                                                          ││ Mem     9G/16G    │
│                                                                          ││ Port    25565     │
╰──────────────────────────────────────────────────────────────────────────╯╰───────────────────╯
╭──────────────────────────────────────────────────────────────────────────────────────────────╮
│ > type a server command (e.g. say hi, op <name>, stop)…                                        │
╰──────────────────────────────────────────────────────────────────────────────────────────────╯
```

## Contents

- [What it does](#what-it-does)
- [Requirements](#requirements)
- [Install &amp; run](#install--run)
- [First launch](#first-launch)
- [The views](#the-views)
- [Keys](#keys)
- [Where things live](#where-things-live)
- [How it works](#how-it-works)
- [Notes &amp; disclaimer](#notes--disclaimer)

## What it does

- **Runs your server, unchanged.** yasc just spawns `java … -jar <jar> nogui` in
  the server's own folder and talks to it over stdin/stdout — no wrapper mod, no
  agent, no re-packaging. Anything that works on the command line works here.
- **Start fresh or import.** On launch you either pick a saved server, **import
  an existing folder** that already has a server jar, or **create a new one** by
  choosing a flavor + version that yasc downloads (and, for Forge/NeoForge,
  installs) for you.
- **Every flavor, every niche.** Vanilla; the Bukkit/Spigot plugin servers
  **Paper, Folia, Purpur**; the mod loaders **Fabric, Forge, NeoForge**; and the
  proxies **Velocity, Waterfall, BungeeCord** — each downloaded from its own
  official source, with the right launch (EULA + `nogui` for game servers, no
  EULA for proxies, installer handling for Forge/NeoForge). Spigot/CraftBukkit
  (which can't be redistributed) are supported via **import**.
- **One panel for everything**, navigable entirely from the keyboard *and mouse*:
  - **Console** — live colored server log with a real **scrollback** (mouse
    wheel or `PgUp`/`PgDn`, with a scrollbar and stable position while new lines
    stream in), plus a command line with history that pipes straight to the
    server.
  - **Players** — who's online and for how long, with an Enter-menu to op / deop
    / kick / ban / whitelist without remembering the syntax.
  - **Properties** — a live editor for `server.properties` that preserves your
    comments and key order, writing changes straight back to disk.
  - **Files** — browse the server directory and open any text config in a
    scrolling viewer you can edit line-by-line (`Ctrl+S` to save).
  - **Plugins / Mods** — list the jars in `plugins/` (or `mods/` for modded),
    toggle each one on/off (it renames to `.jar.disabled`), and **browse +
    install from a choice of libraries**: [Modrinth](https://modrinth.com)
    (everything), [Hangar](https://hangar.papermc.io) (Paper/Velocity/Waterfall),
    and [SpigotMC](https://www.spigotmc.org) (Bukkit/Spigot). `Tab` switches
    source; only the libraries that fit your flavor are shown, and Modrinth
    results are pre-filtered to *this* flavor **and** *this* Minecraft version.
  - **Network** — *make the server reachable by friends.* Shows your LAN + public
    IP and the exact join address, and offers every common way to expose it:
    manual port-forward instructions with a real **external reachability test**,
    one-key **automatic UPnP port-forwarding**, and one-key **tunnels**
    (**playit.gg**, **ngrok**, **bore** — and the framework makes adding more
    trivial) that run the service's own agent and surface the public address
    live, no router config needed.
  - **Server** — the control center: Start / Stop / Restart / Force-kill, accept
    the EULA, and see the jar, Java, memory and port at a glance.
- **Live telemetry sidebar** — server state, uptime, player count; **TPS** and
  **MSPT** (polled quietly so they never spam the console — Paper-family & Forge),
  the Java process's RAM/CPU, plugin/mod count and world size on disk; host
  memory + load; the listening port and current public/tunnel join address —
  always visible from every tab.
- **Lightweight & zero-dependency.** Pure Node built-ins (`child_process`,
  `https`, `fs`) and a custom diff renderer, so an idle panel barely costs any
  CPU and there's nothing to `npm audit`.

## Requirements

- **Node.js 18+** (developed on 22) — to run the panel.
- **A Java runtime** on `PATH` appropriate for your server version (e.g. Java
  21+ for modern Minecraft). yasc shells out to `java`; it does not bundle one.
- A terminal with **truecolor + Unicode** — Windows Terminal, iTerm2, Kitty,
  WezTerm, or most modern Linux terminals.
- An **internet connection** only when *creating* a server (to download the jar).
  Importing and running are fully offline.

## Install &amp; run

```sh
npm install      # nothing to install — there are no dependencies
npm start
```

Or, after `npm link`, just run `yasc`.

## First launch

You land on the home screen. Three things can happen there:

1. **Open a saved server** — anything you've created or imported before.
2. **＋ Create a new server** —
   1. pick a **flavor** (`↑`/`↓` through Vanilla · Paper/Folia/Purpur ·
      Fabric/Forge/NeoForge · Velocity/Waterfall/BungeeCord);
   2. pick a **version** — there's a **search box**; just type to filter the
      live list (e.g. `1.21`), newest first;
   3. name it and set its **memory** (e.g. `2G`);
   4. accept the **Minecraft EULA** (skipped for proxies, which don't need one).

   yasc downloads the right server jar — running the installer first for
   Forge/NeoForge — writes `eula.txt`, lays down a sane default
   `server.properties` (game servers only), and drops you into the panel with
   the server starting.
3. **⮈ Import an existing folder** — the folder field works like **Spotlight**:
   as you type a path it lists the sub-folders and **flags the ones that look
   like a server** (`●` already a server, `◆` has a `.jar`). `↑`/`↓` to pick,
   `Tab` to open a folder, `Enter` to import. Your worlds, plugins and configs
   are left exactly as they are.

Servers you create live under **`servers/<name>` next to the project** (so the
whole thing is portable and easy to find); imported servers stay wherever they
already are. Either way they're remembered for next time, and **stopping a
server drops you back to this screen** so you can switch between servers without
restarting yasc.

## The views

| # | View | What you can do |
|---|------|-----------------|
| 1 | **Console** | read the live log, scroll (mouse wheel / `PgUp`/`PgDn`), send commands, recall history (`↑`/`↓`) |
| 2 | **Players** | see who's online; `Enter` opens op/kick/ban/whitelist actions |
| 3 | **Properties** | `↑`/`↓` a key, `Enter` to edit its value — saved to `server.properties` |
| 4 | **Files** | browse the folder, open a text config, `Enter` a line to edit it, `Ctrl+S` to save |
| 5 | **Plugins** | toggle plugin/mod jars, or `Enter` the top row to **search (live, as you type) & install** from Modrinth / Hangar / SpigotMC (`Tab` switches source) |
| 6 | **Network** | LAN/public IP + join address; test reachability, UPnP-forward, or start a tunnel |
| 7 | **Server** | Start / Stop / Restart / Force-kill, accept EULA, **back to server list**, view jar/Java/RAM/port |

### Making your server public (Network tab)

Pick a method with `↑`/`↓` and press `Enter`:

| Method | What it does | Needs |
|--------|--------------|-------|
| **Direct / LAN** | shows the `192.168.x.x:port` address for friends on your wifi | nothing |
| **Port forward (manual)** | shows the exact router rule (TCP `port` → your PC), then **tests from the internet** whether it worked | router access |
| **Auto port-forward (UPnP)** | asks your router to open the port automatically | UPnP enabled on the router |
| **playit.gg / ngrok / bore** | runs that service's agent and shows the public address it hands back | the agent installed (yasc links you to it if not) |

The chosen public address is shown in the **Status** sidebar from every tab, so
you always have something to paste to your friends. Tunnels are stopped
automatically when you close the panel or switch servers.

Most changes to properties, plugins and configs take effect on the next
**server restart** (Server tab → Restart, or `Ctrl+R`).

When the server stops (by your command, the Stop action, or a crash) you get a
prompt to **Restart**, go **Back to the server list**, **Stay** on the console,
or **Quit** — so a stopped server never just leaves you staring at a dead
terminal.

## Keys

| Input | Action |
|-------|--------|
| `Tab` / `Shift+Tab` | next / previous view |
| `F1`–`F7` | jump straight to a view |
| `Ctrl+R` | start the server, or restart it if it's running |
| `Ctrl+C` | quit the panel (offers to stop the server first if it's running) |
| `Ctrl+L` | force a full redraw |
| mouse wheel | scroll the console / move the selection; click a tab to switch view |

**Console view:** type a command + `Enter` to send it · `↑`/`↓` command history ·
mouse wheel or `PgUp`/`PgDn` scroll · `Esc` clear the line.
**List views:** `↑`/`↓` (or wheel) to move, `Enter` to act, `Esc` to back out.
**Editors (properties / files):** `Enter` edit · `Ctrl+S` save · `Esc` cancel.

### Console commands

Anything you type goes to the server, **except** lines starting with `.`, which
are yasc's own commands:

| Command | Action |
|---------|--------|
| `.ram <size>` | set the server's allocated memory, e.g. `.ram 4G` or `.ram 4096M` (applies on the next restart) |
| `.help` | list these commands |
| `.quit` | close the panel |

## Where things live

```
servers/                 lives right next to the project — portable & easy to find
servers/servers.json     the registry of your servers + last-used settings
servers/<name>/          servers created by the wizard (jar, worlds, configs…)
servers/.cache/          scratch space for downloads
logs/yasc.log            the panel's own log (separate from the server's log)
```

(`servers/` is git-ignored, so your worlds and jars never get committed.)

The panel's log (`logs/yasc.log`, with the previous run kept as
`yasc.prev.log`) records lifecycle events and errors with full stack traces —
hand it over for bug reports. Your server still writes its own
`logs/latest.log` as usual; yasc doesn't touch it.

## How it works

There is no magic and no background service. [`src/server.js`](src/server.js)
`spawn`s the Java process in the server's directory, line-buffers its console,
classifies each line (info / warn / error), and parses the meaningful ones
("Done!", join/leave, the `list` reply, and quietly-polled `tps`/`mspt`) into
live state. Commands you type are written to the process's stdin exactly as a
console operator would. Everything you see is painted by a small custom terminal
engine in [`src/terminal.js`](src/terminal.js) that keeps an in-memory cell
buffer and emits only the cells that changed each frame.

| File | Responsibility |
|------|----------------|
| [`src/index.js`](src/index.js) | entry point; logging, wires launcher → download/install → app |
| [`src/launcher.js`](src/launcher.js) | the home screen / create / import wizard |
| [`src/app.js`](src/app.js) | the panel: tabs, views, sidebar, telemetry, input/mouse routing |
| [`src/server.js`](src/server.js) | spawns + supervises the Java server, parses console, polls TPS |
| [`src/providers.js`](src/providers.js) | version lists + jar/installer downloads for every flavor |
| [`src/libraries.js`](src/libraries.js) | unified plugin/mod search + install (Modrinth/Hangar/SpigotMC) |
| [`src/modrinth.js`](src/modrinth.js) | Modrinth API + per-flavor compatibility mapping |
| [`src/network.js`](src/network.js) | LAN/public IP + external port-reachability check |
| [`src/upnp.js`](src/upnp.js) | automatic port forwarding via UPnP IGD (SSDP + SOAP) |
| [`src/tunnels.js`](src/tunnels.js) | runs tunnel agents (playit.gg/ngrok/bore) + parses their output |
| [`src/properties.js`](src/properties.js) | comment-preserving `server.properties` editor |
| [`src/java.js`](src/java.js) | Java detection + launch-flag/RAM helpers |
| [`src/stats.js`](src/stats.js) | best-effort RAM/CPU sampling of the server process |
| [`src/terminal.js`](src/terminal.js) | ANSI cell buffer, diff renderer, keyboard input |
| [`src/config.js`](src/config.js) | the `~/.yasc` server registry |
| [`src/logger.js`](src/logger.js) | crash-safe file logger + console capture |

Run the offline layout smoke test (no server, Java or TTY needed) with:

```sh
npm test        # node test/render-test.js
```

## Notes &amp; disclaimer

- Version lists and jars come straight from each project's own authoritative
  source (Mojang, PaperMC's v3 *fill* API for Paper/Folia/Velocity/Waterfall,
  PurpurMC, FabricMC, the Forge promotions feed, the NeoForge Maven, and the
  BungeeCord CI), so the "latest" you're offered really is the latest.
  Plugins/mods come from Modrinth, Hangar, and SpigotMC; Hangar/SpigotMC entries
  that are hosted off-site or premium can't be auto-installed, so yasc links you
  to the download instead. You must accept the
  [Minecraft EULA](https://aka.ms/MinecraftEULA) to run a game server — yasc asks
  before it ever starts one (proxies need no EULA).
- **Forge/NeoForge** download an *installer* that yasc runs once (`--installServer`)
  before first launch, then starts the server via the generated run arguments.
  This is the heaviest path and needs a matching Java version for that MC release.
- Closing the panel offers to stop the server cleanly first; if you choose to
  quit while it's running, the child process is stopped so you don't leave an
  orphaned server holding the port.
- For tunnels, yasc runs the service's **own official agent** (playit/ngrok/bore)
  that you install — it doesn't bundle or reimplement them, and it never
  downloads an executable behind your back. If an agent isn't installed, the
  Network tab just points you to it. Exposing a server to the internet is your
  call: keep it updated, and consider a whitelist (`white-list=true`).
- Licensed under the [MIT License](LICENSE).
