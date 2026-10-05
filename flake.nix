{
  description = "Bookmark Mirror browser extension";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  outputs = { self, nixpkgs }: let
    systems = [ "aarch64-darwin" "x86_64-darwin" "aarch64-linux" "x86_64-linux" ];
    each = nixpkgs.lib.genAttrs systems;
  in {
    packages = each (system: let pkgs = import nixpkgs { inherit system; }; in {
      default = pkgs.stdenvNoCC.mkDerivation {
        pname = "bookmark-mirror";
        version = "0.1.0";
        src = ./extension;
        installPhase = ''mkdir -p $out/share/bookmark-mirror; cp -R . $out/share/bookmark-mirror/'';
      };
    });
    homeModules.default = {config, lib, pkgs, ...}: let cfg = config.programs.bookmark-mirror; in {
      options.programs.bookmark-mirror = {
        enable = lib.mkEnableOption "Bookmark Mirror extension files";
        package = lib.mkOption {type = lib.types.package; default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;};
      };
      config = lib.mkIf cfg.enable {
        home.packages = [cfg.package];
        home.file.".local/share/bookmark-mirror".source = "${cfg.package}/share/bookmark-mirror";
      };
    };
  };
}
