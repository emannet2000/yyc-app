# YYC Driver mobile location client

This Expo starter runs an authenticated driver session and sends GPS points to `/api/gps/location` from an Expo background location task.

1. Set `EXPO_PUBLIC_API_URL` to the HTTPS origin used by `PUBLIC_ORIGIN`.
2. From this directory run `npm install` and `npm run start`.
3. Use a development build on a physical iOS or Android device. Background location is not available in Expo Go on all platforms.
4. Sign in, enter an assigned active shipment ID, grant foreground and background location access, then start sharing.

Location is sent only for the entered shipment. The server checks that the signed-in driver is assigned and that the shipment is active. Build and test platform permission prompts and store-review requirements before distributing the app. MFA sign-in and a native job selector are not included yet.
