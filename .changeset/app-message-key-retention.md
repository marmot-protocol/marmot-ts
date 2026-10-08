---
"@internet-privacy/marmot-ts": patch
---

Pass a Marmot `ClientConfig` to every ts-mls call. `defaultMarmotClientConfig` was exported
but never used, so ts-mls defaults applied: receiver secrets for only 4 past epochs, and only
10 skipped generations per sender. An application message sent five commits before the
receiver read it was dropped as "epoch too old", although `app_payload_past_epoch_limit` is 5;
and a member catching up on a burst (relays return newest first) lost every message more
than ten generations behind the newest. Retention is now 5 epochs, 100 skipped generations
and a 1000-step forward limit, matching MDK's OpenMLS configuration.
