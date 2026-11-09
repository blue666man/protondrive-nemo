{
  description = "Unofficial FUSE mount of Proton Drive for Nemo and other Linux file managers";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
  };

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems =
        f: nixpkgs.lib.genAttrs systems (system: f system (import nixpkgs { inherit system; }));
    in
    {
      packages = forAllSystems (
        _system: pkgs: rec {
          protondrive-nemo = pkgs.callPackage ./nix/package.nix { };
          default = protondrive-nemo;
        }
      );

      apps = forAllSystems (
        system: _pkgs: {
          default = {
            type = "app";
            program = "${self.packages.${system}.default}/bin/protondrive-nemo";
          };
        }
      );

      devShells = forAllSystems (
        _system: pkgs: {
          default = pkgs.callPackage ./nix/devshell.nix { };
        }
      );

      # Import into home-manager, then set:
      #   programs.protondrive-nemo.enable = true;
      homeManagerModules.default = import ./nix/module.nix;

      formatter = forAllSystems (_system: pkgs: pkgs.nixfmt-tree);
    };
}
