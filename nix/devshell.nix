{
  pkgs,
  lib ? pkgs.lib,
}:

pkgs.mkShell {
  packages = with pkgs; [
    nodejs_22
    pkg-config
    python3
    gnumake
    gcc
    fuse
    sqlite
    gnupg
  ];

  shellHook = ''
    export PKG_CONFIG_PATH="${
      lib.makeSearchPath "lib/pkgconfig" [
        pkgs.fuse.dev
        pkgs.sqlite.dev
      ]
    }:''${PKG_CONFIG_PATH:-}"

    export LD_LIBRARY_PATH="${
      lib.makeLibraryPath [
        pkgs.fuse
        pkgs.sqlite
        pkgs.stdenv.cc.cc.lib
      ]
    }:''${LD_LIBRARY_PATH:-}"

    echo "protondrive-nemo dev shell"
    echo "  node: $(node --version)  npm: $(npm --version)"
    echo "  deps:  see README.md, Build: npm ci --ignore-scripts, then the"
    echo "         fuse-native utimens sed patch, then the native rebuild"
    echo "         (an unpatched binding fails tier 2)"
    echo "  build: npm run build"
    echo "  test:  npm test   (tier 2: npm run test:mount)"
  '';
}
