{
  lib,
  buildNpmPackage,
  nodejs_22,
  fuse,
  sqlite,
  gnupg,
  pkg-config,
  autoPatchelfHook,
  makeWrapper,
  stdenv,
}:

let
  pkg = lib.importJSON ../package.json;
in
buildNpmPackage {
  pname = "protondrive-nemo";
  inherit (pkg) version;

  src = lib.cleanSourceWith {
    src = ../.;
    filter =
      path: _type:
      let
        base = baseNameOf path;
      in
      !(builtins.elem base [
        "node_modules"
        "dist"
        ".git"
        ".direnv"
        "result"
      ]);
  };

  nodejs = nodejs_22;

  # Hash of the npm dependency tree; refresh with:
  #   nix run nixpkgs#prefetch-npm-deps -- package-lock.json
  npmDepsHash = "sha256-zmGQkSqRrNxHXyoTvw56scsh2mLmnLoIbd5zlTFLFoM=";

  # No dependency's lifecycle scripts run (core-js, exifreader, esbuild
  # postinstalls); only the two native addons are built, below.
  npmRebuildFlags = [ "--ignore-scripts" ];

  nativeBuildInputs = [
    pkg-config
    autoPatchelfHook
    makeWrapper
  ];

  buildInputs = [
    fuse
    sqlite
    stdenv.cc.cc.lib
  ];

  # Native addons (fuse-native, better-sqlite3) must compile against the
  # Nix-provided libraries; there is no network in the sandbox, so never
  # try to download prebuilt binaries.
  env.npm_config_build_from_source = "true";

  postConfigure = ''
    # @cocalc/fuse-native <= 2.4.3 passes atime as mtime to utimens
    # (sagemathinc/fuse-native#3). A no-op once fixed upstream; a reshaped
    # file fails the build here instead of silently shipping the bug.
    # The guard looks only inside the utimens method, so an unrelated
    # `l->mtime, 5` elsewhere in the file cannot satisfy it.
    sed -i '/FUSE_METHOD_VOID(utimens/,/^})/ s/FUSE_UINT64_TO_INTS_ARGV(l->atime, 5)/FUSE_UINT64_TO_INTS_ARGV(l->mtime, 5)/' \
      node_modules/@cocalc/fuse-native/fuse-native.c
    sed -n '/FUSE_METHOD_VOID(utimens/,/^})/p' node_modules/@cocalc/fuse-native/fuse-native.c \
      | grep -q 'FUSE_UINT64_TO_INTS_ARGV(l->mtime, 5)' \
      || { echo "fuse-native utimens patch did not apply" >&2; exit 1; }
    echo "fuse-native utimens patch applied"
    npm rebuild @cocalc/fuse-native better-sqlite3 --build-from-source --foreground-scripts
  '';

  # `npm run build` (esbuild bundle) is the default npmBuildScript.

  # The credentials store shells out to gpg; put it on PATH so `nix run`
  # doesn't depend on the caller's environment.
  postInstall = ''
    wrapProgram $out/bin/protondrive-nemo --prefix PATH : ${lib.makeBinPath [ gnupg ]}
  '';

  # Typecheck the sources (esbuild only strips types) and run the tier-1
  # tests (stub FUSE, fake Drive, throwaway GNUPGHOME).
  doCheck = true;
  nativeCheckInputs = [ gnupg ];
  checkPhase = ''
    runHook preCheck
    export HOME=$TMPDIR
    npm run typecheck
    npm test
    runHook postCheck
  '';

  meta = {
    description = pkg.description;
    homepage = "https://github.com/blue666man/protondrive-nemo";
    license = lib.licenses.mit;
    mainProgram = "protondrive-nemo";
    platforms = lib.platforms.linux;
  };
}
