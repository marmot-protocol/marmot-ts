---
"@internet-privacy/marmot-ts": major
---

**Breaking:** Add APNs and FCM token encryption for MIP-05; replace encryptWebPushToken with encryptPushToken(subscription, pubkey) accepting a PushSubscription union; NotificationServerConfig is now a discriminated union of WebPushServerConfig | ApnsServerConfig | FcmServerConfig; WebPushSubscription now requires a type: "web-push" discriminant field
