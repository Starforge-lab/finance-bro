const { withAppBuildGradle } = require('expo/config-plugins');
const RELEASE_BLOCK = /^([ \t]*)release[ \t]*\{[ \t]*\r?\n([\s\S]*?)(^\1\}[ \t]*$)/gm;
const DEBUG_SIGNING = /^([ \t]*)signingConfig[ \t]+signingConfigs\.debug[ \t]*$/gm;

function clearReleaseSigning(contents, language = 'groovy') {
  if (language !== 'groovy') {
    throw new Error('Unsigned Android release check requires the Groovy build.gradle format');
  }
  const blocks = [...contents.matchAll(RELEASE_BLOCK)];
  if (blocks.length !== 1) {
    throw new Error('Expected one generated release build type, found ' + blocks.length);
  }
  const [block, , body] = blocks[0];
  const signingLines = [...body.matchAll(DEBUG_SIGNING)];
  if (signingLines.length !== 1) {
    throw new Error('Expected one default signing line in release build type, found ' + signingLines.length);
  }
  const updatedBody = body.replace(DEBUG_SIGNING, '$1signingConfig null');
  const start = blocks[0].index;
  return contents.slice(0, start) + block.replace(body, updatedBody) + contents.slice(start + block.length);
}

function withUnsignedAndroidRelease(config) {
  return withAppBuildGradle(config, (mod) => {
    mod.modResults.contents = clearReleaseSigning(mod.modResults.contents, mod.modResults.language);
    return mod;
  });
}

module.exports = withUnsignedAndroidRelease;
module.exports.clearReleaseSigning = clearReleaseSigning;
