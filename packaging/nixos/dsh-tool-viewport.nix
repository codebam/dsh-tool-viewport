{
  lib,
  stdenvNoCC,
  fetchFromGitHub,
  nodejs,
}:

stdenvNoCC.mkDerivation {
  pname = "dsh-tool-viewport";
  version = "0.1.0";

  # @codebam/dsh-tool-viewport is published from its own repository; this
  # host pins the reviewed revision so the profile copies exactly the plugin
  # sources it was tested with. The hash is the tag's unpacked-tree hash
  # (nix-prefetch-url --unpack, converted to SRI).
  #
  # NOTE: placeholder — the v0.1.0 tag does not exist yet. After pushing it:
  #   nix-prefetch-url --unpack https://github.com/codebam/dsh-tool-viewport/archive/refs/tags/v0.1.0.tar.gz
  # then `nix hash convert --to sri` the result into `hash` below
  # (or set it from nix-build's reported expected hash).
  src = fetchFromGitHub {
    owner = "codebam";
    repo = "dsh-tool-viewport";
    rev = "v0.1.0";
    hash = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  };

  nativeBuildInputs = [ nodejs ];

  # The published files are the ESM sources; there is no build step.
  dontBuild = true;

  # home/agents.nix copies this directory into $DSH_HOME next to the profile's
  # node_modules symlink, where Node resolves the @deepseek-ai/* peers.
  installPhase = ''
    runHook preInstall
    install -d -m 0755 "$out/lib/dsh-tool-viewport"
    cp -r index.mjs package.json src "$out/lib/dsh-tool-viewport/"
    cp LICENSE "$out/lib/dsh-tool-viewport/"
    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    for file in index.mjs src/*.mjs; do
      ${lib.getExe nodejs} --check "$file"
    done
    runHook postInstallCheck
  '';

  meta = {
    description = "Model-facing Viewport desktop control (screenshot, pointer, click, scroll, type, keys) for the DeepSeek Harness";
    homepage = "https://github.com/codebam/dsh-tool-viewport";
    license = lib.licenses.mit;
    platforms = lib.platforms.all;
  };
}
