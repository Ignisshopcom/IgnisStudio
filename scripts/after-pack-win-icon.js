const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

module.exports = async function afterPackWinIcon(context) {
  if (context.electronPlatformName === 'darwin') {
    if (context.appOutDir.includes('-temp')) {
      return;
    }

    const appName = `${context.packager.appInfo.productFilename}.app`;
    const appPath = path.join(context.appOutDir, appName);

    if (!fs.existsSync(appPath)) {
      throw new Error(`Cannot ad-hoc sign macOS app, app was not found: ${appPath}`);
    }

    execFileSync('codesign', [
      '--force',
      '--deep',
      '--sign',
      '-',
      '--timestamp=none',
      appPath
    ], { stdio: 'inherit' });
    return;
  }

  if (context.electronPlatformName !== 'win32') return;

  const projectDir = context.packager.info.projectDir;
  const exeName = `${context.packager.appInfo.productFilename}.exe`;
  const exePath = path.join(context.appOutDir, exeName);
  const iconPath = path.join(projectDir, 'src', 'img', 'icon.ico');
  const rceditPath = path.join(projectDir, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe');

  if (!fs.existsSync(exePath)) {
    throw new Error(`Cannot set Ignis icon, EXE was not found: ${exePath}`);
  }
  if (!fs.existsSync(iconPath)) {
    throw new Error(`Cannot set Ignis icon, icon was not found: ${iconPath}`);
  }
  if (!fs.existsSync(rceditPath)) {
    throw new Error(`Cannot set Ignis icon, rcedit was not found: ${rceditPath}`);
  }

  execFileSync(rceditPath, [
    exePath,
    '--set-icon', iconPath,
    '--set-version-string', 'CompanyName', 'IgnisShop',
    '--set-version-string', 'FileDescription', 'Ignis Studio',
    '--set-version-string', 'ProductName', 'Ignis Studio',
    '--set-version-string', 'InternalName', 'Ignis Studio',
    '--set-version-string', 'OriginalFilename', exeName
  ], { stdio: 'inherit' });
};
