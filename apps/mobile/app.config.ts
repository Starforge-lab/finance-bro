import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * APP_VARIANT=development gives the dev build its own id and name so it can sit
 * next to a store install on the same phone. Set per profile in eas.json.
 */
const IS_DEV = process.env.APP_VARIANT === 'development';
const IS_SOURCE_CHECK = process.env.ANDROID_RELEASE_SOURCE_CHECK === '1';

if (IS_SOURCE_CHECK && IS_DEV) {
  throw new Error('The Android release source check requires the production variant');
}

// Working id; the product name is decided after v1. Must be final before the first store upload.
const BASE_ID = 'com.rohangupta.financebro';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: IS_DEV ? 'finance-bro (dev)' : 'finance-bro',
  slug: 'finance-bro',
  owner: 'starforge-lab',
  extra: {
    eas: { projectId: 'd958cc1c-c6f5-449f-a397-8a106d5790d9' },
  },
  version: '0.1.0',
  orientation: 'portrait',
  icon: './assets/images/icon.png',
  scheme: 'financebro',
  userInterfaceStyle: 'automatic',
  ios: {
    bundleIdentifier: IS_DEV ? `${BASE_ID}.dev` : BASE_ID,
    icon: './assets/expo.icon',
  },
  android: {
    package: IS_DEV ? `${BASE_ID}.dev` : BASE_ID,
    adaptiveIcon: {
      backgroundColor: '#E6F4FE',
      foregroundImage: './assets/images/android-icon-foreground.png',
      backgroundImage: './assets/images/android-icon-background.png',
      monochromeImage: './assets/images/android-icon-monochrome.png',
    },
    predictiveBackGestureEnabled: false,
  },
  web: { bundler: 'metro', output: 'single' },
  plugins: [
    ...(IS_SOURCE_CHECK ? ['./plugins/withUnsignedAndroidRelease.cjs'] : []),
    ['expo-router', {
      headers: {
        'Cross-Origin-Embedder-Policy': 'credentialless',
        'Cross-Origin-Opener-Policy': 'same-origin',
      },
    }],
    'expo-sqlite',
    'expo-secure-store',
    'expo-image',
    [
      'expo-splash-screen',
      {
        backgroundColor: '#F6F6F4',
        image: './assets/images/splash-icon.png',
        imageWidth: 76,
        dark: { backgroundColor: '#0E0F10' },
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
    reactCompiler: true,
  },
});
