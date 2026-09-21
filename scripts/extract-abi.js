// Writes the ABIs the frontend uses to frontend/src/abi/<Name>.js, one file per contract in the
// form `export const <Name>Abi = [...]`. Run after `npx hardhat compile`:
//
//   npx hardhat run scripts/extract-abi.js
//   npm run abi
//
// Only files whose content changes are rewritten; the script prints what it updated.
const fs = require("fs");
const path = require("path");

const CONTRACTS = {
  HoodSaleLens: "contracts/HoodSaleLens.sol/HoodSaleLens.json",
  HoodSaleToken: "contracts/HoodSaleToken.sol/HoodSaleToken.json",
  LiquidityLocker: "contracts/LiquidityLocker.sol/LiquidityLocker.json",
  Presale: "contracts/Presale.sol/Presale.json",
  PresaleFactory: "contracts/PresaleFactory.sol/PresaleFactory.json",
  QuickLaunch: "contracts/QuickLaunch.sol/QuickLaunch.json",
  RewardsToken: "contracts/tokens/RewardsToken.sol/RewardsToken.json",
  StandardToken: "contracts/tokens/StandardToken.sol/StandardToken.json",
  TaxToken: "contracts/tokens/TaxToken.sol/TaxToken.json",
  TokenFactory: "contracts/TokenFactory.sol/TokenFactory.json",
  TokenMetadataRegistry: "contracts/TokenMetadataRegistry.sol/TokenMetadataRegistry.json",
  Treasury: "contracts/Treasury.sol/Treasury.json",
  // The Uniswap v4 launch mode
  HoodSaleV4Hook: "contracts/v4/HoodSaleV4Hook.sol/HoodSaleV4Hook.json",
  HoodSaleV4Lens: "contracts/v4/HoodSaleV4Lens.sol/HoodSaleV4Lens.json",
  HoodSaleV4Router: "contracts/v4/HoodSaleV4Router.sol/HoodSaleV4Router.json",
  HoodSaleTokenV4: "contracts/v4/tokens/HoodSaleTokenV4.sol/HoodSaleTokenV4.json",
  RewardsTokenV4: "contracts/v4/tokens/RewardsTokenV4.sol/RewardsTokenV4.json",
  V4Launcher: "contracts/v4/V4Launcher.sol/V4Launcher.json",
  V4PositionLocker: "contracts/v4/V4PositionLocker.sol/V4PositionLocker.json",
  // The v4 fee mode: the tax is the pool's fee, and its lens and router are second instances of
  // HoodSaleV4Lens and HoodSaleV4Router, so they need no ABI of their own
  HoodSaleV4FeeHook: "contracts/v4/fee/HoodSaleV4FeeHook.sol/HoodSaleV4FeeHook.json",
  V4FeeLauncher: "contracts/v4/fee/V4FeeLauncher.sol/V4FeeLauncher.json",
};

function main() {
  const artifacts = path.join(__dirname, "..", "artifacts");
  const outDir = path.join(__dirname, "..", "..", "frontend", "src", "abi");
  if (!fs.existsSync(outDir)) throw new Error(`frontend abi directory not found: ${outDir}`);
  let updated = 0;
  for (const [name, rel] of Object.entries(CONTRACTS)) {
    const artifactPath = path.join(artifacts, rel);
    if (!fs.existsSync(artifactPath)) throw new Error(`artifact missing, run npx hardhat compile: ${artifactPath}`);
    const { abi } = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    const content = `export const ${name}Abi = ${JSON.stringify(abi, null, 2)};\n`;
    const target = path.join(outDir, `${name}.js`);
    const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
    if (current === content) continue;
    fs.writeFileSync(target, content);
    updated++;
    console.log(`${current === null ? "created" : "updated"} frontend/src/abi/${name}.js`);
  }
  console.log(updated === 0 ? "ABIs already up to date" : `${updated} ABI file(s) written`);
}

main();
