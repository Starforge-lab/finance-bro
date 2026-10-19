const { AndroidConfig, createRunOncePlugin, withAndroidManifest } = require('expo/config-plugins');

const MODULE_NAME = '@finance-bro/sms-reader';
const MODULE_VERSION = '0.1.0';
const RECEIVER_NAME = 'expo.modules.smsreader.SmsWakeReceiver';
const SMS_RECEIVED_ACTION = 'android.provider.Telephony.SMS_RECEIVED';
const BROADCAST_SMS_PERMISSION = 'android.permission.BROADCAST_SMS';

function withSmsReader(config, { enabled = false } = {}) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults;
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
    manifest.manifest['uses-permission'] = (manifest.manifest['uses-permission'] ?? []).filter((item) =>
      !['android.permission.READ_SMS', 'android.permission.RECEIVE_SMS'].includes(item.$['android:name'])
    );
    if (!enabled) {
      application.receiver = (application.receiver ?? []).filter((item) => item.$['android:name'] !== RECEIVER_NAME);
      return config;
    }
    AndroidConfig.Permissions.addPermission(manifest, 'android.permission.READ_SMS');
    AndroidConfig.Permissions.addPermission(manifest, 'android.permission.RECEIVE_SMS');

    application.receiver ??= [];
    let receiver = application.receiver.find((item) => item.$['android:name'] === RECEIVER_NAME);

    if (!receiver) {
      receiver = {
        $: {},
        'intent-filter': [],
      };
      application.receiver.push(receiver);
    }

    receiver.$ = {
      ...receiver.$,
      'android:name': RECEIVER_NAME,
      'android:enabled': 'true',
      'android:exported': 'true',
      'android:permission': BROADCAST_SMS_PERMISSION,
    };
    receiver['intent-filter'] ??= [];

    if (!receiver['intent-filter'].some((filter) =>
      filter.action?.some((action) => action.$['android:name'] === SMS_RECEIVED_ACTION)
    )) {
      receiver['intent-filter'].push({
        action: [{ $: { 'android:name': SMS_RECEIVED_ACTION } }],
      });
    }

    return config;
  });
}

module.exports = createRunOncePlugin(withSmsReader, MODULE_NAME, MODULE_VERSION);
