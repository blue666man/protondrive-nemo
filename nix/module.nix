{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.programs.protondrive-nemo;

  # Environment variables baked into the wrapper as *defaults*: an explicit
  # value in the user's shell still wins.
  env = {
    PROTONDRIVE_NEMO_GPG_RECIPIENT = cfg.gpgRecipient;
    PROTONDRIVE_NEMO_CREDENTIALS_FILE = cfg.credentialsFile;
    PROTONDRIVE_NEMO_DATA_DIR = cfg.dataDir;
    PROTONDRIVE_NEMO_BASE_URL = cfg.baseUrl;
    PROTONDRIVE_NEMO_LOG_LEVEL = cfg.logLevel;
  }
  // lib.optionalAttrs (cfg.cachePaths != [ ]) {
    PROTONDRIVE_NEMO_CACHE_PATHS = lib.concatStringsSep "," cfg.cachePaths;
  }
  // lib.optionalAttrs cfg.ephemeralCache {
    PROTONDRIVE_NEMO_EPHEMERAL_CACHE = "1";
  }
  // lib.optionalAttrs cfg.allowRoot {
    PROTONDRIVE_NEMO_FUSE_ALLOW_ROOT = "1";
  }
  // cfg.environment;

  setEnvFlags = lib.concatStringsSep " " (
    lib.mapAttrsToList (name: value: "--set-default ${name} ${lib.escapeShellArg value}") (
      lib.filterAttrs (_: value: value != null && value != "") env
    )
  );

  # Wrap the CLI so the configured defaults are present no matter how it is
  # launched, without installing a service. The mount is started by hand
  # (`protondrive-nemo mount`), which avoids the boot-time problem of gpg-agent
  # not being unlocked yet.
  wrapped =
    pkgs.runCommand "protondrive-nemo-wrapped"
      {
        nativeBuildInputs = [ pkgs.makeWrapper ];
        meta.mainProgram = "protondrive-nemo";
      }
      ''
        mkdir -p $out/bin
        makeWrapper ${lib.getExe cfg.package} $out/bin/protondrive-nemo ${setEnvFlags}
      '';
in
{
  options.programs.protondrive-nemo = {
    enable = lib.mkEnableOption "the protondrive-nemo Proton Drive CLI (installs a wrapper with your defaults)";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ./package.nix { };
      defaultText = lib.literalExpression "protondrive-nemo";
      description = "Package providing the `protondrive-nemo` CLI.";
    };

    gpgRecipient = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "0xDEADBEEF";
      description = ''
        GPG key id/fingerprint, set as `PROTONDRIVE_NEMO_GPG_RECIPIENT`. The
        session is encrypted to this key at rest and decrypted in memory
        through gpg-agent; there is no keychain or passphrase fallback. Run
        `protondrive-nemo login` once to create the encrypted credentials file.
      '';
    };

    cachePaths = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [
        "/Documents"
        "/Photos"
      ];
      description = ''
        Only files under these Drive folders (POSIX paths under "My Files")
        may be kept in the persistent local cache. Files elsewhere are still
        readable, but their decrypted copy is deleted as soon as it is closed.

        Empty (the default) caches every file. Set as the comma-separated
        `PROTONDRIVE_NEMO_CACHE_PATHS`.
      '';
    };

    ephemeralCache = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Never keep decrypted content on disk: every open uses a throwaway
        copy and the whole content cache is wiped when the mount starts and
        stops. Overrides `cachePaths`. Set as `PROTONDRIVE_NEMO_EPHEMERAL_CACHE=1`.
      '';
    };

    credentialsFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "/home/user/.local/share/protondrive-nemo/auth-session.gpg";
      description = ''
        Path to the GPG-encrypted session file of the default account
        (`PROTONDRIVE_NEMO_CREDENTIALS_FILE`). Other `--account` profiles
        ignore it and keep `auth-session.gpg` in their own data directory.
      '';
    };

    dataDir = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Override the cache + app data directory (`PROTONDRIVE_NEMO_DATA_DIR`).";
    };

    baseUrl = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "drive-api.proton.me";
      description = "Drive API host (`PROTONDRIVE_NEMO_BASE_URL`).";
    };

    logLevel = lib.mkOption {
      type = lib.types.nullOr (
        lib.types.enum [
          "DEBUG"
          "INFO"
          "WARNING"
          "ERROR"
        ]
      );
      default = null;
      description = "Console log level (`PROTONDRIVE_NEMO_LOG_LEVEL`). Unset, the CLI defaults to INFO.";
    };

    allowRoot = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Let root use the mount (e.g. a backup job), via
        `PROTONDRIVE_NEMO_FUSE_ALLOW_ROOT=1`. Needs `programs.fuse.userAllowOther = true`
        in the NixOS configuration.
      '';
    };

    environment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      example = {
        PROTONDRIVE_NEMO_FUSE_DEBUG = "1";
      };
      description = "Extra environment variables to bake into the wrapper as defaults.";
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ wrapped ];
  };
}
