const path = require('path');
const { notarize } = require('@electron/notarize');

module.exports = async function notarizeMac(context) {
  if (context.electronPlatformName !== 'darwin') return;

  if (process.env.IGNIS_NOTARIZE !== '1') {
    console.log('Skipping macOS notarization because IGNIS_NOTARIZE is not set to 1.');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  const appBundleId = context.packager.appInfo.id;

  const apiKey = process.env.APPLE_API_KEY;
  const apiKeyId = process.env.APPLE_API_KEY_ID;
  const apiIssuer = process.env.APPLE_API_ISSUER;
  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD || process.env.APPLE_ID_PASSWORD || process.env.APPLE_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;

  let options;
  if (apiKey && apiKeyId && apiIssuer) {
    options = {
      appBundleId,
      appPath,
      appleApiKey: apiKey,
      appleApiKeyId: apiKeyId,
      appleApiIssuer: apiIssuer,
    };
  } else if (appleId && appleIdPassword && teamId) {
    options = {
      appBundleId,
      appPath,
      appleId,
      appleIdPassword,
      teamId,
    };
  } else {
    throw new Error('macOS notarization needs either APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER, or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID.');
  }

  if (teamId && options) options.teamId = teamId;

  console.log(`Notarizing ${appPath} as ${appBundleId}...`);
  await notarize(options);
  console.log('macOS notarization finished.');
};
