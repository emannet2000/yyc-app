import React, { useEffect, useState } from 'react';
import { Button, SafeAreaView, Text, TextInput, View } from 'react-native';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as SecureStore from 'expo-secure-store';

const TASK = 'yyc-background-location';
const api = process.env.EXPO_PUBLIC_API_URL;
TaskManager.defineTask(TASK, async ({ data, error }) => {
  if (error || !data?.locations?.length) return;
  const session = await SecureStore.getItemAsync('yyc.session');
  const shipmentId = await SecureStore.getItemAsync('yyc.shipment');
  if (!session || !shipmentId || !api) return;
  const loc = data.locations[data.locations.length - 1].coords;
  await fetch(`${api}/api/gps/location`, {
    method: 'POST',
    headers: { Origin: api, Cookie: `yyc_session=${session}`, 'X-CSRF-Token': await SecureStore.getItemAsync('yyc.csrf'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ shipmentId, latitude: loc.latitude, longitude: loc.longitude, accuracy: loc.accuracy, speed: loc.speed, heading: loc.heading, altitude: loc.altitude })
  });
});

export default function App() {
  const [email, setEmail] = useState(''), [password, setPassword] = useState(''), [mfaCode, setMfaCode] = useState(''), [needsMfa, setNeedsMfa] = useState(false), [shipmentId, setShipmentId] = useState(''), [message, setMessage] = useState('Sign in and start location sharing for an active delivery.');
  useEffect(() => { SecureStore.getItemAsync('yyc.shipment').then(x => x && setShipmentId(x)); }, []);
  async function login() {
    if (!api) return setMessage('Set EXPO_PUBLIC_API_URL to your HTTPS YYC server URL.');
    const response = await fetch(`${api}/api/login`, { method: 'POST', headers: { Origin: api, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, ...(needsMfa ? { mfaCode } : {}) }) });
    const result = await response.json();
    const cookie = response.headers.get('set-cookie') || '';
    const token = cookie.match(/yyc_session=([a-f0-9]{64})/)?.[1];
    if (result.mfaRequired) { setNeedsMfa(true); return setMessage('Enter your authenticator code to finish signing in.'); }
    if (!response.ok || !token) return setMessage(result.error || 'Could not sign in.');
    setNeedsMfa(false);
    await SecureStore.setItemAsync('yyc.session', token);
    await SecureStore.setItemAsync('yyc.csrf', result.csrf);
    setMessage(`Signed in as ${result.user.name}. Enter an active shipment ID to share location.`);
  }
  async function toggleTracking() {
    if (!shipmentId.startsWith('YYC-')) return setMessage('Enter a valid YYC shipment ID.');
    const foreground = await Location.requestForegroundPermissionsAsync();
    if (foreground.status !== 'granted') return setMessage('Location permission is required to share an active delivery.');
    const background = await Location.requestBackgroundPermissionsAsync();
    if (background.status !== 'granted') return setMessage('Allow background location so updates continue when the phone is locked.');
    await SecureStore.setItemAsync('yyc.shipment', shipmentId);
    const started = await Location.hasStartedLocationUpdatesAsync(TASK);
    if (started) {
      await Location.stopLocationUpdatesAsync(TASK);
      setMessage('Background location sharing stopped.');
    } else {
      await Location.startLocationUpdatesAsync(TASK, { accuracy: Location.Accuracy.Balanced, timeInterval: 30000, distanceInterval: 100, pausesUpdatesAutomatically: true, foregroundService: { notificationTitle: 'YYC delivery location active', notificationBody: 'Location is shared for your active delivery.' } });
      setMessage('Background location sharing is active for this delivery.');
    }
  }
  return <SafeAreaView style={{ flex: 1, padding: 24, justifyContent: 'center', gap: 14 }}><Text style={{ fontSize: 28, fontWeight: '700' }}>YYC Driver</Text><Text>{message}</Text><TextInput autoCapitalize="none" keyboardType="email-address" placeholder="Email" value={email} onChangeText={setEmail} style={{ borderWidth: 1, padding: 12 }} /><TextInput secureTextEntry placeholder="Password" value={password} onChangeText={setPassword} style={{ borderWidth: 1, padding: 12 }} />{needsMfa ? <TextInput keyboardType="number-pad" placeholder="Authenticator or backup code" value={mfaCode} onChangeText={setMfaCode} style={{ borderWidth: 1, padding: 12 }} /> : null}<Button title={needsMfa ? 'Verify and sign in' : 'Sign in'} onPress={login} /><TextInput autoCapitalize="characters" placeholder="YYC-1001" value={shipmentId} onChangeText={setShipmentId} style={{ borderWidth: 1, padding: 12 }} /><Button title="Start / stop background location" onPress={toggleTracking} /></SafeAreaView>;
}
