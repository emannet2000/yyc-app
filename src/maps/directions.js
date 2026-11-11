import { Client } from '@googlemaps/google-maps-services-js';

/**
 * Google Maps Integration Module for YYC Brokers
 * Handles routing, distance calculations, and ETA
 */

const apiKey = process.env.GOOGLE_MAPS_API_KEY;

let mapsClient = null;

if (apiKey) {
  mapsClient = new Client({});
  console.log('[Google Maps] Initialized');
} else {
  console.warn('[Google Maps] API key not configured. Maps and ETA features will be disabled.');
}

/**
 * Calculate route between two addresses
 * @param {string} origin - Origin address or lat,lng
 * @param {string} destination - Destination address or lat,lng
 * @returns {Promise<Object>}
 */
export async function getDirections(origin, destination) {
  if (!mapsClient) {
    throw new Error('Google Maps not configured. Set GOOGLE_MAPS_API_KEY in environment variables.');
  }

  const response = await mapsClient.directions({
    params: {
      origin,
      destination,
      key: apiKey,
      mode: 'driving',
      departure_time: 'now',
      traffic_model: 'best_guess'
    }
  });

  if (response.data.status !== 'OK' || response.data.routes.length === 0) {
    throw new Error(`Failed to get directions: ${response.data.status}`);
  }

  const route = response.data.routes[0];
  const leg = route.legs[0];

  return {
    distance: {
      meters: leg.distance.value,
      text: leg.distance.text
    },
    duration: {
      seconds: leg.duration.value,
      text: leg.duration.text
    },
    durationInTraffic: leg.duration_in_traffic
      ? {
          seconds: leg.duration_in_traffic.value,
          text: leg.duration_in_traffic.text
        }
      : null,
    startAddress: leg.start_address,
    endAddress: leg.end_address,
    steps: leg.steps.map(step => ({
      distance: step.distance.text,
      duration: step.duration.text,
      instruction: step.html_instructions.replace(/<[^>]*>/g, '') // Strip HTML
    })),
    polyline: route.overview_polyline.points
  };
}

/**
 * Calculate ETA using Distance Matrix API
 * @param {Object} origin - {lat, lng} or address
 * @param {Object} destination - {lat, lng} or address
 * @returns {Promise<Object>}
 */
export async function calculateETA(origin, destination, departureTime = 'now') {
  if (!mapsClient) {
    throw new Error('Google Maps not configured. Set GOOGLE_MAPS_API_KEY in environment variables.');
  }

  // Format origin and destination
  const formatLocation = (loc) => {
    if (typeof loc === 'string') return loc;
    if (loc.lat && loc.lng) return `${loc.lat},${loc.lng}`;
    throw new Error('Invalid location format');
  };

  const response = await mapsClient.distancematrix({
    params: {
      origins: [formatLocation(origin)],
      destinations: [formatLocation(destination)],
      key: apiKey,
      mode: 'driving',
      departure_time: departureTime,
      traffic_model: 'best_guess'
    }
  });

  if (response.data.status !== 'OK') {
    throw new Error(`Failed to calculate ETA: ${response.data.status}`);
  }

  const element = response.data.rows[0].elements[0];

  if (element.status !== 'OK') {
    throw new Error(`Failed to calculate ETA: ${element.status}`);
  }

  const etaSeconds = element.duration_in_traffic
    ? element.duration_in_traffic.value
    : element.duration.value;

  const etaDate = new Date(Date.now() + etaSeconds * 1000);

  return {
    distance: {
      meters: element.distance.value,
      text: element.distance.text
    },
    duration: {
      seconds: element.duration.value,
      text: element.duration.text
    },
    durationInTraffic: element.duration_in_traffic
      ? {
          seconds: element.duration_in_traffic.value,
          text: element.duration_in_traffic.text
        }
      : null,
    eta: etaDate.toISOString(),
    etaTimestamp: etaDate.getTime()
  };
}

/**
 * Geocode an address to coordinates
 * @param {string} address - Address to geocode
 * @returns {Promise<Object>}
 */
export async function geocodeAddress(address) {
  if (!mapsClient) {
    throw new Error('Google Maps not configured. Set GOOGLE_MAPS_API_KEY in environment variables.');
  }

  const response = await mapsClient.geocode({
    params: {
      address,
      key: apiKey
    }
  });

  if (response.data.status !== 'OK' || response.data.results.length === 0) {
    throw new Error(`Failed to geocode address: ${response.data.status}`);
  }

  const result = response.data.results[0];

  return {
    lat: result.geometry.location.lat,
    lng: result.geometry.location.lng,
    formattedAddress: result.formatted_address,
    placeId: result.place_id
  };
}

/**
 * Reverse geocode coordinates to address
 * @param {number} lat - Latitude
 * @param {number} lng - Longitude
 * @returns {Promise<string>}
 */
export async function reverseGeocode(lat, lng) {
  if (!mapsClient) {
    throw new Error('Google Maps not configured. Set GOOGLE_MAPS_API_KEY in environment variables.');
  }

  const response = await mapsClient.reverseGeocode({
    params: {
      latlng: `${lat},${lng}`,
      key: apiKey
    }
  });

  if (response.data.status !== 'OK' || response.data.results.length === 0) {
    throw new Error(`Failed to reverse geocode: ${response.data.status}`);
  }

  return response.data.results[0].formatted_address;
}

/**
 * Check if Google Maps is configured
 * @returns {boolean}
 */
export function isConfigured() {
  return mapsClient !== null;
}
