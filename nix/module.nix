{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.alp;
in
{
  imports = [
    (lib.mkRenamedOptionModule [ "services" "alp" "allowedHosts" ] [ "services" "alp" "hostnames" ])
    # alp-rename-keep-start
    # COMPAT(paseo-nix-options): added after v1.0.0 on 2026-09-27; remove after 2027-03-27.
    # alp 1.0.0 declared its options as services.paseo.*. A configuration that still sets them
    # keeps evaluating, with a rename warning. Only option names carry over: the defaults for
    # user, group, and dataDir are now alp and /var/lib/alp, so a host that relied on the old
    # defaults sets `user = "paseo"; group = "paseo"; dataDir = "/var/lib/paseo";` or moves its
    # state before switching, or the daemon starts on an empty home.
    (lib.mkRenamedOptionModule [ "services" "paseo" ] [ "services" "alp" ])
    # alp-rename-keep-end
  ];

  options.services.alp = {
    enable = lib.mkEnableOption "Alp, a self-hosted daemon for AI coding agents";

    package = lib.mkPackageOption pkgs "alp" { };

    user = lib.mkOption {
      type = lib.types.str;
      default = "alp";
      description = "User account under which Alp runs.";
    };

    group = lib.mkOption {
      type = lib.types.str;
      default = "alp";
      description = "Group under which Alp runs.";
    };

    dataDir = lib.mkOption {
      type = lib.types.str;
      default =
        if cfg.user == "alp"
        then "/var/lib/alp"
        else "/home/${cfg.user}/.alp";
      defaultText = lib.literalExpression ''
        if cfg.user == "alp"
        then "/var/lib/alp"
        else "/home/''${cfg.user}/.alp"
      '';
      description = "Directory for Alp state (ALP_HOME). Stores agent data, config, and logs.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 6767;
      description = "Port for the Alp daemon to listen on.";
    };

    listenAddress = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = "Address for the Alp daemon to bind to.";
    };

    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Whether to open the firewall for the Alp daemon port.";
    };

    hostnames = lib.mkOption {
      type = lib.types.either (lib.types.enum [ true ]) (lib.types.listOf lib.types.str);
      default = [ ];
      example = [ ".example.com" "myhost.local" ];
      description = ''
        Hostnames the Alp daemon accepts in the Host header (DNS rebinding protection).
        Localhost and IP addresses are always allowed by default.

        Use a leading dot to match a domain and all its subdomains
        (e.g. `".example.com"` matches `example.com` and `foo.example.com`).

        Set to `true` to allow any host (not recommended).
      '';
    };

    relay = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = ''
          Whether to enable relay-based remote access. When false, the daemon
          runs with `--no-relay` and only accepts direct (LAN/loopback)
          connections.
        '';
      };

      mode = lib.mkOption {
        type = lib.types.enum [ "hosted" "remote" ];
        default = "hosted";
        description = ''
          How the daemon reaches the relay when `relay.enable = true`:

          - `"hosted"` (default): use the maintainer-hosted `relay-alp.anhlp.com` relay.
            Preserves the current behavior; no extra options needed.
          - `"remote"`: connect to a self-hosted relay at
            `relay.host:relay.port`. Sets `ALP_RELAY_ENDPOINT` and
            `ALP_RELAY_USE_TLS` for the daemon.

          A `"local"` mode (running a relay on the same host as a systemd
          unit) is not yet implemented — the relay package currently only
          ships a Cloudflare Workers adapter. Tracked separately.
        '';
      };

      host = lib.mkOption {
        type = lib.types.str;
        default = "";
        example = "relay.example.com";
        description = "Relay hostname. Required when `relay.mode = \"remote\"`.";
      };

      port = lib.mkOption {
        type = lib.types.port;
        default = 443;
        description = "Relay port. Used when `relay.mode = \"remote\"`.";
      };

      useTls = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Whether to use TLS when connecting to the relay. Used when `relay.mode = \"remote\"`.";
      };

      publicUseTls = lib.mkOption {
        type = lib.types.nullOr lib.types.bool;
        default = null;
        description = ''
          Whether the public (client-facing) relay endpoint uses TLS.
          When `null` (default), the daemon falls back to `relay.useTls`.
          Override when the internal path is plain `ws://` behind a
          TLS-terminating reverse proxy.
        '';
      };
    };

    inheritUserEnvironment = lib.mkOption {
      type = lib.types.bool;
      default = cfg.user != "alp";
      defaultText = lib.literalExpression ''cfg.user != "alp"'';
      description = ''
        Whether to include the user's profile PATH in the service environment.

        When Alp runs as a real user (not the default system user), AI agents
        need access to the user's tools (git, ssh, etc.). This adds the user's
        NixOS profile, home-manager profile (`~/.nix-profile/bin` and
        `~/.local/state/nix/profile/bin`), and system paths so agents can use
        them without manually setting PATH.

        Enabled by default when `user` is set to a non-default value.
      '';
    };

    environment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      example = lib.literalExpression ''
        {
          ALP_RELAY_ENDPOINT = "relay-alp.anhlp.com:443";
        }
      '';
      description = "Extra environment variables for the Alp daemon.";
    };

    settings = lib.mkOption {
      type = (pkgs.formats.json { }).type;
      default = { };
      example = lib.literalExpression ''
        {
          daemon.mcp = { enabled = true; injectIntoAgents = false; };
          agents.providers.myAcp = {
            extends = "acp";
            label = "My Agent";
            command = { path = "/run/current-system/sw/bin/my-acp"; };
          };
          log.file = { level = "info"; path = "/var/lib/alp/daemon.log"; };
        }
      '';
      description = ''
        Declarative content for `$ALP_HOME/config.json`. Rendered to JSON
        and installed on every service start.

        Runtime mutations to `config.json` (e.g. via `alp daemon set-password`
        or the mobile app toggling MCP injection / provider overrides) are
        overwritten on the next restart. Pick one: manage via this option, or
        manage via the CLI — not both.

        The full schema is defined by `PersistedConfigSchema` in
        `packages/server/src/server/persisted-config.ts`.
      '';
    };
  };

  config = lib.mkIf cfg.enable (
    let
      settingsFile = (pkgs.formats.json { }).generate "alp-config.json" cfg.settings;
    in
    {
    assertions = [
      {
        assertion = !(cfg.relay.enable && cfg.relay.mode == "remote" && cfg.relay.host == "");
        message = ''
          services.alp.relay.host must be set when relay.mode = "remote".
        '';
      }
    ];

    users.users.${cfg.user} = lib.mkIf (cfg.user == "alp") {
      isSystemUser = true;
      group = cfg.group;
      home = cfg.dataDir;
    };

    users.groups.${cfg.group} = lib.mkIf (cfg.group == "alp") { };

    systemd.tmpfiles.rules = [
      "d ${cfg.dataDir} 0700 ${cfg.user} ${cfg.group} - -"
    ];

    systemd.services.alp = {
      description = "Alp - self-hosted daemon for AI coding agents";
      after = [ "network.target" ];
      wantedBy = [ "multi-user.target" ];

      preStart = lib.mkIf (cfg.settings != { }) ''
        install -m 0600 ${settingsFile} ${cfg.dataDir}/config.json
      '';

      environment = {
        ALP_HOME = cfg.dataDir;
        ALP_LISTEN = "${cfg.listenAddress}:${toString cfg.port}";
      } // lib.optionalAttrs cfg.inheritUserEnvironment (
        let
          # Match dataDir's convention. We can't read users.users.<name>.home
          # because the user may be managed outside NixOS.
          userHome = "/home/${cfg.user}";
        in {
          # mkForce overrides the default PATH from NixOS's systemd module (which
          # only includes store paths for coreutils/grep/sed/systemd). When the
          # daemon runs as a real user, also include home-manager profile paths
          # so user-installed CLIs (claude, opencode, codex, ...) are reachable
          # by agent processes the daemon spawns.
          PATH = lib.mkForce (lib.concatStringsSep ":" (
            lib.optionals (cfg.user != "alp") [
              "${userHome}/.nix-profile/bin"
              "${userHome}/.local/state/nix/profile/bin"
            ]
            ++ [
              "/etc/profiles/per-user/${cfg.user}/bin"
              "/run/current-system/sw/bin"
              "/run/wrappers/bin"
              "/nix/var/nix/profiles/default/bin"
            ]
          ));
        }
      ) // lib.optionalAttrs (cfg.hostnames == true) {
        ALP_HOSTNAMES = "true";
      } // lib.optionalAttrs (lib.isList cfg.hostnames && cfg.hostnames != [ ]) {
        ALP_HOSTNAMES = lib.concatStringsSep "," cfg.hostnames;
      } // lib.optionalAttrs (cfg.relay.enable && cfg.relay.mode == "remote") {
        ALP_RELAY_ENDPOINT = "${cfg.relay.host}:${toString cfg.relay.port}";
        ALP_RELAY_USE_TLS = if cfg.relay.useTls then "true" else "false";
      } // lib.optionalAttrs (cfg.relay.enable && cfg.relay.mode == "remote" && cfg.relay.publicUseTls != null) {
        ALP_RELAY_PUBLIC_USE_TLS = if cfg.relay.publicUseTls then "true" else "false";
      } // cfg.environment;

      serviceConfig = {
        Type = "simple";
        User = cfg.user;
        Group = cfg.group;

        ExecStart =
          "${cfg.package}/bin/alp-server"
          + lib.optionalString (!cfg.relay.enable) " --no-relay";

        Restart = "on-failure";
        RestartSec = 5;

        # Graceful shutdown (server handles SIGTERM with a 10s timeout)
        KillSignal = "SIGTERM";
        TimeoutStopSec = 15;
      };
    };

    environment.systemPackages = [ cfg.package ];

    networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [ cfg.port ];
    }
  );
}
