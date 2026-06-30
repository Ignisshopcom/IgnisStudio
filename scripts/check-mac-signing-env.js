const requiredSigning = ['CSC_LINK', 'CSC_KEY_PASSWORD'];
const missingSigning = requiredSigning.filter((name) => !process.env[name]);

const hasApiKey = !!(process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER);
const hasAppleId = !!(process.env.APPLE_ID && (process.env.APPLE_APP_SPECIFIC_PASSWORD || process.env.APPLE_ID_PASSWORD || process.env.APPLE_PASSWORD) && process.env.APPLE_TEAM_ID);

if (missingSigning.length || (!hasApiKey && !hasAppleId)) {
  console.error('Missing macOS signing/notarization configuration.');
  if (missingSigning.length) console.error(`Missing signing secrets: ${missingSigning.join(', ')}`);
  if (!hasApiKey && !hasAppleId) {
    console.error('Missing notarization auth. Use either:');
    console.error('- APPLE_API_KEY_BASE64 + APPLE_API_KEY_ID + APPLE_API_ISSUER');
    console.error('- or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID');
  }
  process.exit(1);
}

console.log('macOS signing and notarization environment looks ready.');
