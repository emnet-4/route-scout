import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Autocomplete,
  DirectionsRenderer,
  GoogleMap,
  InfoWindow,
  Marker,
  Polyline,
  useJsApiLoader,
} from '@react-google-maps/api';

type Coordinates = {
  lat: number;
  lng: number;
};

type PriorityLevel = 'must-do' | 'flexible' | 'optional';

type TravelModeOption = 'walking' | 'driving' | 'bicycling' | 'transit';

type Stop = {
  id: string;
  name: string;
  address: string;
  coordinates: Coordinates;
  durationMinutes: number;
  priority: PriorityLevel;
  checked: boolean;
  placeId?: string;
  placeTypes: string[];
  photoUrl?: string;
  openingHoursText?: string[];
};

type PersistedState = {
  stops: Stop[];
  startTime: string;
  originName: string;
  originCoordinates: Coordinates | null;
  originStopId: string | null;
  travelMode: TravelModeOption;
};

type RouteDiff = {
  id: string;
  message: string;
};

type ApiDiagnostics = {
  maps: string;
  places: string;
  directions: string;
  details: string;
};

type TransitLegDetail = {
  fromName: string;
  toName: string;
  summary: string;
  minutes: number;
  instructions: string[];
};

const STORAGE_KEY = 'routescout-v1';
const LIBRARIES: ('places')[] = ['places'];

const DEFAULT_CENTER: Coordinates = { lat: 20, lng: 0 };

const seededStops: Stop[] = [];

function createId() {
  return Math.random().toString(36).slice(2, 10);
}

function toRadians(value: number) {
  return (value * Math.PI) / 180;
}

function haversineKm(from: Coordinates, to: Coordinates) {
  const earthRadiusKm = 6371;
  const deltaLat = toRadians(to.lat - from.lat);
  const deltaLng = toRadians(to.lng - from.lng);
  const lat1 = toRadians(from.lat);
  const lat2 = toRadians(to.lat);

  const a =
    Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
    Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2) * Math.cos(lat1) * Math.cos(lat2);

  return 2 * earthRadiusKm * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function estimateTravelMinutes(from: Coordinates, to: Coordinates) {
  return Math.max(4, Math.round(haversineKm(from, to) * 14 + 4));
}

function estimateTravelMinutesForMode(from: Coordinates, to: Coordinates, mode: TravelModeOption) {
  const distanceKm = haversineKm(from, to);

  if (mode === 'driving') {
    return Math.max(3, Math.round(distanceKm * 4 + 3));
  }

  if (mode === 'bicycling') {
    return Math.max(4, Math.round(distanceKm * 6 + 3));
  }

  if (mode === 'transit') {
    return Math.max(8, Math.round(distanceKm * 5 + 8));
  }

  return estimateTravelMinutes(from, to);
}

function stripHtml(value: string) {
  return value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function formatTransitStep(step: google.maps.DirectionsStep) {
  const instruction = stripHtml(step.instructions || '');

  if (step.travel_mode === google.maps.TravelMode.TRANSIT && step.transit) {
    const transit = step.transit;
    const lineName = transit.line.short_name || transit.line.name || transit.line.vehicle.name;
    const headsign = transit.headsign ? ` toward ${transit.headsign}` : '';
    const departure = transit.departure_stop?.name ? ` from ${transit.departure_stop.name}` : '';
    const arrival = transit.arrival_stop?.name ? ` to ${transit.arrival_stop.name}` : '';

    return `Take ${lineName}${headsign}${departure}${arrival}`;
  }

  return instruction;
}

function formatTransitSegment(route: google.maps.DirectionsRoute, fromName: string, toName: string): TransitLegDetail {
  const minutes = Math.round(route.legs.reduce((sum, leg) => sum + (leg.duration?.value ?? 0), 0) / 60);
  const instructions = route.legs
    .flatMap((leg) => leg.steps.map((step) => formatTransitStep(step)))
    .filter((step, index, allSteps) => step && allSteps.indexOf(step) === index);

  return {
    fromName,
    toName,
    summary: route.summary || `${fromName} to ${toName}`,
    minutes,
    instructions,
  };
}

function travelModeLabel(mode: TravelModeOption) {
  if (mode === 'driving') return 'Driving';
  if (mode === 'bicycling') return 'Bicycling';
  if (mode === 'transit') return 'Transit';
  return 'Walking';
}

function travelModeForGoogle(mode: TravelModeOption) {
  if (mode === 'driving') return google.maps.TravelMode.DRIVING;
  if (mode === 'bicycling') return google.maps.TravelMode.BICYCLING;
  if (mode === 'transit') return google.maps.TravelMode.TRANSIT;
  return google.maps.TravelMode.WALKING;
}

function routeDistance(route: Stop[], origin: Coordinates) {
  return route.reduce((sum, stop, index) => {
    const from = index === 0 ? origin : route[index - 1].coordinates;
    return sum + haversineKm(from, stop.coordinates);
  }, 0);
}

function improveRoute(route: Stop[], origin: Coordinates) {
  const improved = [...route];
  let changed = true;

  while (changed) {
    changed = false;

    for (let left = 0; left < improved.length - 1; left += 1) {
      for (let right = left + 1; right < improved.length; right += 1) {
        const candidate = [
          ...improved.slice(0, left),
          ...improved.slice(left, right + 1).reverse(),
          ...improved.slice(right + 1),
        ];

        if (routeDistance(candidate, origin) < routeDistance(improved, origin)) {
          improved.splice(0, improved.length, ...candidate);
          changed = true;
        }
      }
    }
  }

  return improved;
}

function priorityWeight(priority: PriorityLevel) {
  if (priority === 'must-do') {
    return 4;
  }

  if (priority === 'flexible') {
    return 2;
  }

  return 0.7;
}

function optimizeUnchecked(uncheckedStops: Stop[], origin: Coordinates, mode: TravelModeOption) {
  const remaining = [...uncheckedStops];
  const route: Stop[] = [];
  let currentLocation = origin;

  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestCost = Number.POSITIVE_INFINITY;

    remaining.forEach((stop, index) => {
      const travelMinutes = estimateTravelMinutesForMode(currentLocation, stop.coordinates, mode);
      const priorityBonus = priorityWeight(stop.priority);
      const visitPenalty = stop.durationMinutes * 0.03;
      const cost = travelMinutes + visitPenalty - priorityBonus;

      if (cost < bestCost) {
        bestCost = cost;
        bestIndex = index;
      }
    });

    const [chosen] = remaining.splice(bestIndex, 1);
    route.push(chosen);
    currentLocation = chosen.coordinates;
  }

  return improveRoute(route, origin);
}

function estimateDurationByType(types: string[]) {
  const lowered = new Set(types.map((type) => type.toLowerCase()));

  if (lowered.has('museum') || lowered.has('art_gallery')) {
    return 90;
  }

  if (lowered.has('ice_cream_shop') || lowered.has('bakery') || lowered.has('cafe')) {
    return 20;
  }

  if (lowered.has('tourist_attraction') || lowered.has('point_of_interest') || lowered.has('landmark')) {
    return 15;
  }

  return 30;
}

function formatEta(startTime: string, totalMinutes: number) {
  const [hours, minutes] = startTime.split(':').map(Number);
  const start = new Date();
  start.setHours(hours, minutes, 0, 0);

  const eta = new Date(start.getTime() + totalMinutes * 60000);

  return eta.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function stopLink(stop: Stop) {
  return `https://www.google.com/maps/dir/?api=1&destination=${stop.coordinates.lat},${stop.coordinates.lng}`;
}

function readStoredState(): PersistedState {
  const fallback: PersistedState = {
    stops: seededStops,
    startTime: '09:00',
    originName: 'Choose origin',
    originCoordinates: null,
    originStopId: null,
    travelMode: 'walking',
  };

  const raw = localStorage.getItem(STORAGE_KEY);

  if (!raw) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<PersistedState>;

    if (
      !Array.isArray(parsed.stops) ||
      typeof parsed.startTime !== 'string' ||
      typeof parsed.originName !== 'string' ||
      (parsed.originCoordinates !== null && typeof parsed.originCoordinates?.lat !== 'number') ||
      (parsed.originCoordinates !== null && typeof parsed.originCoordinates?.lng !== 'number') ||
      (parsed.originStopId !== null && typeof parsed.originStopId !== 'string') ||
      (parsed.travelMode !== 'walking' && parsed.travelMode !== 'driving' && parsed.travelMode !== 'bicycling' && parsed.travelMode !== 'transit')
    ) {
      return fallback;
    }

    return {
      stops: parsed.stops,
      startTime: parsed.startTime,
      originName: parsed.originName,
      originCoordinates: parsed.originCoordinates,
      originStopId: parsed.originStopId ?? null,
      travelMode: parsed.travelMode,
    };
  } catch {
    return fallback;
  }
}

export default function App() {
  const stored = useMemo(() => readStoredState(), []);
  const [stops, setStops] = useState<Stop[]>(stored.stops);
  const [startTime, setStartTime] = useState(stored.startTime);
  const [originName, setOriginName] = useState(stored.originName);
  const [originCoordinates, setOriginCoordinates] = useState<Coordinates | null>(stored.originCoordinates);
  const [originStopId, setOriginStopId] = useState<string | null>(stored.originStopId);
  const [travelMode, setTravelMode] = useState<TravelModeOption>(stored.travelMode);
  const [searchValue, setSearchValue] = useState('');
  const [map, setMap] = useState<google.maps.Map | null>(null);
  const [directions, setDirections] = useState<google.maps.DirectionsResult | null>(null);
  const [transitPaths, setTransitPaths] = useState<Coordinates[][]>([]);
  const [transitLegs, setTransitLegs] = useState<TransitLegDetail[]>([]);
  const [activeStopId, setActiveStopId] = useState<string | null>(null);
  const [routeDiffs, setRouteDiffs] = useState<RouteDiff[]>([]);
  const [showRouteDiffs, setShowRouteDiffs] = useState(false);
  const [highlightStopIds, setHighlightStopIds] = useState<string[]>([]);
  const [draggedStopId, setDraggedStopId] = useState<string | null>(null);
  const [manualOrderDirty, setManualOrderDirty] = useState(false);
  const [walkingMode, setWalkingMode] = useState(false);
  const [currentPosition, setCurrentPosition] = useState<Coordinates | null>(null);
  const [rerouteHint, setRerouteHint] = useState('');
  const [nudgeHint, setNudgeHint] = useState('');
  const [travelMinutesFromDirections, setTravelMinutesFromDirections] = useState(0);
  const [apiDiagnostics, setApiDiagnostics] = useState<ApiDiagnostics | null>(null);
  const [runningApiDiagnostics, setRunningApiDiagnostics] = useState(false);

  const watchIdRef = useRef<number | null>(null);
  const autocompleteRef = useRef<google.maps.places.Autocomplete | null>(null);
  const placesServiceRef = useRef<google.maps.places.PlacesService | null>(null);
  const geocoderRef = useRef<google.maps.Geocoder | null>(null);

  const mapsApiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
  const mapsEnabled = Boolean(mapsApiKey);

  const { isLoaded, loadError } = useJsApiLoader({
    id: 'routescout-google-script',
    googleMapsApiKey: mapsApiKey ?? '',
    libraries: LIBRARIES,
  });

  const remainingStops = useMemo(
    () => stops.filter((stop) => !stop.checked && stop.id !== originStopId),
    [stops, originStopId],
  );
  const completedCount = stops.length - remainingStops.length;

  const mapCenter = useMemo(() => {
    if (currentPosition) {
      return currentPosition;
    }

    if (originCoordinates) {
      return originCoordinates;
    }

    return remainingStops[0]?.coordinates ?? DEFAULT_CENTER;
  }, [currentPosition, originCoordinates, remainingStops]);

  const activeOrigin = useMemo(
    () => currentPosition ?? originCoordinates ?? remainingStops[0]?.coordinates ?? DEFAULT_CENTER,
    [currentPosition, originCoordinates, remainingStops],
  );
  const canOpenFullRoute = travelMode !== 'transit' || remainingStops.length <= 1;

  const totalRemainingMinutes = useMemo(
    () => remainingStops.reduce((sum, stop) => sum + stop.durationMinutes, 0) + travelMinutesFromDirections,
    [remainingStops, travelMinutesFromDirections],
  );

  const fullRouteLink = useMemo(() => {
    if (remainingStops.length === 0 || !canOpenFullRoute) {
      return '';
    }

    const origin = activeOrigin;
    const destination = remainingStops[remainingStops.length - 1].coordinates;
    const waypoints = remainingStops.slice(0, -1).map((stop) => `${stop.coordinates.lat},${stop.coordinates.lng}`).join('|');

    const params = new URLSearchParams({
      api: '1',
      origin: `${origin.lat},${origin.lng}`,
      destination: `${destination.lat},${destination.lng}`,
      travelmode: travelMode,
    });

    if (waypoints) {
      params.set('waypoints', waypoints);
    }

    return `https://www.google.com/maps/dir/?${params.toString()}`;
  }, [activeOrigin, remainingStops, travelMode, canOpenFullRoute]);

  useEffect(() => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        stops,
        startTime,
        originName,
        originCoordinates,
        originStopId,
        travelMode,
      }),
    );
  }, [stops, startTime, originName, originCoordinates, originStopId, travelMode]);

  useEffect(() => {
    if (!isLoaded || !map) {
      return;
    }

    placesServiceRef.current = new google.maps.places.PlacesService(map);
    geocoderRef.current = new google.maps.Geocoder();
  }, [isLoaded, map]);

  useEffect(() => {
    if (!walkingMode) {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
      setCurrentPosition(null);
      setNudgeHint('');
      return;
    }

    if (!navigator.geolocation) {
      setWalkingMode(false);
      return;
    }

    watchIdRef.current = navigator.geolocation.watchPosition(
      (position) => {
        setCurrentPosition({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        });
      },
      () => {
        setWalkingMode(false);
      },
      {
        enableHighAccuracy: true,
        maximumAge: 10000,
      },
    );

    return () => {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
    };
  }, [walkingMode]);

  useEffect(() => {
    if (!currentPosition || remainingStops.length === 0) {
      setNudgeHint('');
      return;
    }

    const next = remainingStops[0];
    const distance = haversineKm(currentPosition, next.coordinates);

    if (distance < 0.15) {
      setNudgeHint(`You are close to ${next.name}. Want to check it off?`);
    } else {
      setNudgeHint('');
    }
  }, [currentPosition, remainingStops]);

  useEffect(() => {
    if (!isLoaded || remainingStops.length === 0) {
      setDirections(null);
      setTransitPaths([]);
      setTransitLegs([]);
      setTravelMinutesFromDirections(0);
      return;
    }

    const origin = activeOrigin;

    if (travelMode === 'transit') {
      setDirections(null);

      const transitSegments = remainingStops.map((stop, index) => ({
        fromCoordinates: index === 0 ? origin : remainingStops[index - 1].coordinates,
        toCoordinates: stop.coordinates,
        fromName: index === 0 ? originName : remainingStops[index - 1].name,
        toName: stop.name,
      }));

      Promise.all(
        transitSegments.map(
          (segment) =>
            new Promise<{ path: Coordinates[]; minutes: number; detail: TransitLegDetail }>((resolve) => {
              const service = new google.maps.DirectionsService();

              service.route(
                {
                  origin: segment.fromCoordinates,
                  destination: segment.toCoordinates,
                  travelMode: google.maps.TravelMode.TRANSIT,
                  provideRouteAlternatives: false,
                },
                (result, status) => {
                  if (status === google.maps.DirectionsStatus.OK && result) {
                    const route = result.routes[0];
                    const travelSeconds = route.legs.reduce((sum, leg) => sum + (leg.duration?.value ?? 0), 0);
                    const path = route.overview_path.map((point) => ({ lat: point.lat(), lng: point.lng() }));
                    resolve({
                      path,
                      minutes: Math.round(travelSeconds / 60),
                      detail: formatTransitSegment(route, segment.fromName, segment.toName),
                    });
                    return;
                  }

                  const fallbackMinutes = estimateTravelMinutesForMode(segment.fromCoordinates, segment.toCoordinates, 'transit');
                  resolve({
                    path: [segment.fromCoordinates, segment.toCoordinates],
                    minutes: fallbackMinutes,
                    detail: {
                      fromName: segment.fromName,
                      toName: segment.toName,
                      summary: `${segment.fromName} to ${segment.toName}`,
                      minutes: fallbackMinutes,
                      instructions: ['Transit directions unavailable for this leg.'],
                    },
                  });
                },
              );
            }),
        ),
      ).then((results) => {
        setTransitPaths(results.map((result) => result.path));
        setTransitLegs(results.map((result) => result.detail));
        setTravelMinutesFromDirections(results.reduce((sum, result) => sum + result.minutes, 0));
      });

      return;
    }

    setTransitPaths([]);
    setTransitLegs([]);
    const service = new google.maps.DirectionsService();

    const request: google.maps.DirectionsRequest = {
      origin,
      destination: remainingStops[remainingStops.length - 1].coordinates,
      waypoints: remainingStops.slice(0, -1).map((stop) => ({
        location: stop.coordinates,
        stopover: true,
      })),
      travelMode: travelModeForGoogle(travelMode),
      optimizeWaypoints: false,
    };

    service.route(request, (result, status) => {
      if (status === google.maps.DirectionsStatus.OK && result) {
        setDirections(result);
        const travelSeconds = result.routes[0]?.legs.reduce((sum, leg) => sum + (leg.duration?.value ?? 0), 0) ?? 0;
        setTravelMinutesFromDirections(Math.round(travelSeconds / 60));
      } else {
        setDirections(null);
        const fallback = remainingStops.reduce((sum, stop, index) => {
          const from = index === 0 ? origin : remainingStops[index - 1].coordinates;
          return sum + estimateTravelMinutesForMode(from, stop.coordinates, travelMode);
        }, 0);
        setTravelMinutesFromDirections(fallback);
      }
    });
  }, [isLoaded, remainingStops, activeOrigin, travelMode, originName]);

  function addStop(stop: Stop) {
    setStops((current) => [...current, stop]);
    setSearchValue('');
  }

  function updateStop(id: string, patch: Partial<Stop>) {
    setStops((current) => current.map((stop) => (stop.id === id ? { ...stop, ...patch } : stop)));
  }

  function onPlaceChanged() {
    const place = autocompleteRef.current?.getPlace();

    if (!place || !place.geometry?.location) {
      return;
    }

    addStop({
      id: createId(),
      name: place.name || 'Unnamed place',
      address: place.formatted_address || 'Address unavailable',
      coordinates: {
        lat: place.geometry.location.lat(),
        lng: place.geometry.location.lng(),
      },
      durationMinutes: estimateDurationByType(place.types || []),
      priority: 'flexible',
      checked: false,
      placeId: place.place_id,
      placeTypes: place.types || [],
      photoUrl: place.photos?.[0]?.getUrl({ maxWidth: 420 }),
      openingHoursText: place.opening_hours?.weekday_text,
    });

    map?.panTo({
      lat: place.geometry.location.lat(),
      lng: place.geometry.location.lng(),
    });
  }

  function onMapClick(event: google.maps.MapMouseEvent) {
    if (!event.latLng) {
      return;
    }

    const coordinates = {
      lat: event.latLng.lat(),
      lng: event.latLng.lng(),
    };

    const geocoder = geocoderRef.current;

    if (!geocoder) {
      addStop({
        id: createId(),
        name: 'Dropped pin',
        address: `${coordinates.lat.toFixed(5)}, ${coordinates.lng.toFixed(5)}`,
        coordinates,
        durationMinutes: 15,
        priority: 'flexible',
        checked: false,
        placeTypes: ['point_of_interest'],
      });
      return;
    }

    geocoder.geocode({ location: coordinates }, (results, status) => {
      if (status === 'OK' && results && results[0]) {
        const best = results[0];

        addStop({
          id: createId(),
          name: best.address_components?.[0]?.long_name || 'Dropped pin',
          address: best.formatted_address,
          coordinates,
          durationMinutes: 15,
          priority: 'flexible',
          checked: false,
          placeId: best.place_id,
          placeTypes: best.types || ['point_of_interest'],
        });
      } else {
        addStop({
          id: createId(),
          name: 'Dropped pin',
          address: `${coordinates.lat.toFixed(5)}, ${coordinates.lng.toFixed(5)}`,
          coordinates,
          durationMinutes: 15,
          priority: 'flexible',
          checked: false,
          placeTypes: ['point_of_interest'],
        });
      }
    });
  }

  function toggleChecked(id: string) {
    const nextStops = stops.map((stop) => (stop.id === id ? { ...stop, checked: !stop.checked } : stop));
    setStops(nextStops);

    const toggled = nextStops.find((stop) => stop.id === id);

    if (toggled?.checked && currentPosition) {
      const next = nextStops
        .filter((stop) => !stop.checked)
        .sort((left, right) => haversineKm(currentPosition, left.coordinates) - haversineKm(currentPosition, right.coordinates))[0];

      if (next) {
        setRerouteHint(`Next suggestion: head to ${next.name} from your current location.`);
      }
    }
  }

  function removeStop(id: string) {
    setStops((current) => current.filter((stop) => stop.id !== id));
    if (activeStopId === id) {
      setActiveStopId(null);
    }
    if (originStopId === id) {
      resetOrigin();
    }
  }

  function setAsOrigin(stop: Stop) {
    setOriginName(stop.name);
    setOriginCoordinates(stop.coordinates);
    setOriginStopId(stop.id);
  }

  function resetOrigin() {
    setOriginName('No origin selected');
    setOriginCoordinates(null);
    setOriginStopId(null);
  }

  function useLiveLocationAsOrigin() {
    if (currentPosition) {
      setOriginName('Live location');
      setOriginCoordinates(currentPosition);
      setOriginStopId(null);
    }
  }

  function swapAt(indexA: number, indexB: number) {
    if (indexA < 0 || indexB < 0 || indexA >= stops.length || indexB >= stops.length) {
      return;
    }

    const next = [...stops];
    const temp = next[indexA];
    next[indexA] = next[indexB];
    next[indexB] = temp;
    setStops(next);
    setManualOrderDirty(true);
  }

  function reorderByDrag(fromId: string, toId: string) {
    const fromIndex = stops.findIndex((stop) => stop.id === fromId);
    const toIndex = stops.findIndex((stop) => stop.id === toId);

    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
      return;
    }

    const next = [...stops];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    setStops(next);
    setManualOrderDirty(true);
  }

  function fetchStopDetails(stop: Stop) {
    if (!stop.placeId || !placesServiceRef.current || (stop.photoUrl && stop.openingHoursText)) {
      return;
    }

    placesServiceRef.current.getDetails(
      {
        placeId: stop.placeId,
        fields: ['photos', 'opening_hours'],
      },
      (result, status) => {
        if (status !== google.maps.places.PlacesServiceStatus.OK || !result) {
          return;
        }

        updateStop(stop.id, {
          photoUrl: result.photos?.[0]?.getUrl({ maxWidth: 420 }),
          openingHoursText: result.opening_hours?.weekday_text,
        });
      },
    );
  }

  function optimizeRoute() {
    if (remainingStops.length < 2) {
      setRouteDiffs([]);
      return;
    }

    const origin = activeOrigin;
    const optimizedUnchecked = optimizeUnchecked(remainingStops, origin, travelMode);

    const beforeOrderIds = remainingStops.map((stop) => stop.id);
    const afterOrderIds = optimizedUnchecked.map((stop) => stop.id);

    const movedIds = afterOrderIds.filter((id, index) => beforeOrderIds[index] !== id);

    const movedDiffs = movedIds.map((id) => {
      const movedStop = optimizedUnchecked.find((stop) => stop.id === id);
      const idx = optimizedUnchecked.findIndex((stop) => stop.id === id);
      const prev = idx > 0 ? optimizedUnchecked[idx - 1].name : 'trip start';
      const next = idx < optimizedUnchecked.length - 1 ? optimizedUnchecked[idx + 1].name : 'final stop';

      return {
        id,
        message: `Moved ${movedStop?.name ?? 'stop'} to reduce travel by clustering between ${prev} and ${next}.`,
      };
    });

    setRouteDiffs(movedDiffs);
    setShowRouteDiffs(false);
    setHighlightStopIds(movedIds);
    window.setTimeout(() => setHighlightStopIds([]), 2200);

    setStops((current) => {
      const untouchedChecked = current.filter((stop) => stop.checked);
      return [...optimizedUnchecked, ...untouchedChecked];
    });

    setManualOrderDirty(false);
  }

  async function runApiDiagnostics() {
    if (!isLoaded || !map) {
      setApiDiagnostics({
        maps: 'not loaded',
        places: 'unknown',
        directions: 'unknown',
        details: 'Map is not initialized yet. Wait for map load and try again.',
      });
      return;
    }

    setRunningApiDiagnostics(true);
    setApiDiagnostics({
      maps: 'checking',
      places: 'checking',
      directions: 'checking',
      details: 'Running API checks...',
    });

    const mapsStatus = typeof google?.maps?.Map === 'function' ? 'ok' : 'failed';

    const placesStatus = await new Promise<string>((resolve) => {
      const service = placesServiceRef.current;

      if (!service) {
        resolve('not initialized');
        return;
      }

      service.findPlaceFromQuery(
        {
          query: 'Museum',
          fields: ['name'],
        },
        (_results, status) => {
          if (
            status === google.maps.places.PlacesServiceStatus.OK ||
            status === google.maps.places.PlacesServiceStatus.ZERO_RESULTS
          ) {
            resolve('ok');
            return;
          }

          if (status === google.maps.places.PlacesServiceStatus.REQUEST_DENIED) {
            resolve('request denied');
            return;
          }

          resolve(String(status || 'unknown'));
        },
      );
    });

    const directionsStatus = await new Promise<string>((resolve) => {
      const service = new google.maps.DirectionsService();
      const destination = {
        lat: mapCenter.lat + 0.005,
        lng: mapCenter.lng + 0.005,
      };

      service.route(
        {
          origin: mapCenter,
          destination,
          travelMode: google.maps.TravelMode.WALKING,
        },
        (_result, status) => {
          if (
            status === google.maps.DirectionsStatus.OK ||
            status === google.maps.DirectionsStatus.ZERO_RESULTS
          ) {
            resolve('ok');
            return;
          }

          if (status === google.maps.DirectionsStatus.REQUEST_DENIED) {
            resolve('request denied');
            return;
          }

          resolve(String(status || 'unknown'));
        },
      );
    });

    const guidance: string[] = [];

    if (mapsStatus !== 'ok') {
      guidance.push('Maps JavaScript API may be disabled or key is invalid.');
    }

    if (placesStatus === 'request denied' || placesStatus === 'not initialized') {
      guidance.push('Places API may be disabled or not allowed by key restrictions.');
    }

    if (directionsStatus === 'request denied') {
      guidance.push('Directions API may be disabled or not allowed by key restrictions.');
    }

    if (guidance.length === 0) {
      guidance.push('All core APIs responded. If the UI still fails, wait 2-5 minutes for key restriction propagation.');
    }

    setApiDiagnostics({
      maps: mapsStatus,
      places: placesStatus,
      directions: directionsStatus,
      details: guidance.join(' '),
    });
    setRunningApiDiagnostics(false);
  }

  const activeStop = stops.find((stop) => stop.id === activeStopId) ?? null;
  const eta = formatEta(startTime, totalRemainingMinutes);

  if (!mapsEnabled) {
    return (
      <main className="setup-screen">
        <h1>Google Maps key required</h1>
        <p>
          Add VITE_GOOGLE_MAPS_API_KEY to your environment and restart the dev server. This build is now map-first and depends on Maps and Places APIs.
        </p>
      </main>
    );
  }

  if (loadError) {
    return (
      <main className="setup-screen">
        <h1>Map failed to load</h1>
        <p>Check your Google Maps API key and enabled APIs, then refresh.</p>
      </main>
    );
  }

  if (!isLoaded) {
    return (
      <main className="setup-screen">
        <h1>Loading map</h1>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <GoogleMap
        mapContainerClassName="map-canvas"
        center={mapCenter}
        zoom={13}
        onLoad={(instance) => setMap(instance)}
        onClick={onMapClick}
        options={{
          streetViewControl: false,
          mapTypeControl: false,
          fullscreenControl: false,
        }}
      >
        {currentPosition ? (
          <Marker
            position={currentPosition}
            icon={{
              path: google.maps.SymbolPath.CIRCLE,
              scale: 7,
              fillColor: '#0b8cff',
              fillOpacity: 1,
              strokeColor: '#ffffff',
              strokeWeight: 2,
            }}
            title="Current location"
          />
        ) : null}

        {directions ? (
          <DirectionsRenderer
            directions={directions}
            options={{
              suppressMarkers: true,
              preserveViewport: true,
              polylineOptions: {
                strokeColor: '#1459ff',
                strokeOpacity: 0.9,
                strokeWeight: 6,
              },
            }}
          />
        ) : null}

        {transitPaths.map((path, index) => (
          <Polyline
            key={`${index}-${path.length}`}
            path={path}
            options={{
              strokeColor: '#1d66d3',
              strokeOpacity: 0.9,
              strokeWeight: 5,
            }}
          />
        ))}

        {stops.map((stop, index) => (
          <Marker
            key={stop.id}
            position={stop.coordinates}
            label={{
              text: String(index + 1),
              color: '#0c1320',
              fontWeight: '700',
            }}
            icon={{
              path: google.maps.SymbolPath.BACKWARD_CLOSED_ARROW,
              fillColor: stop.checked ? '#8b95aa' : '#ffbd53',
              fillOpacity: 0.95,
              strokeColor: '#101f3f',
              strokeWeight: 1,
              scale: 5,
            }}
            onClick={() => {
              setActiveStopId(stop.id);
              fetchStopDetails(stop);
            }}
          />
        ))}

        {activeStop ? (
          <InfoWindow position={activeStop.coordinates} onCloseClick={() => setActiveStopId(null)}>
            <section className="pin-card">
              {activeStop.photoUrl ? <img src={activeStop.photoUrl} alt={activeStop.name} /> : null}
              <h3>{activeStop.name}</h3>
              <p>{activeStop.address}</p>
              {activeStop.openingHoursText ? (
                <details>
                  <summary>Hours</summary>
                  <ul>
                    {activeStop.openingHoursText.map((row) => (
                      <li key={row}>{row}</li>
                    ))}
                  </ul>
                </details>
              ) : null}

              <div className="pin-actions">
                <label>
                  <input
                    type="checkbox"
                    checked={activeStop.checked}
                    onChange={() => toggleChecked(activeStop.id)}
                  />
                  Checked
                </label>
                <button type="button" onClick={() => removeStop(activeStop.id)}>Remove</button>
                <button type="button" onClick={() => setAsOrigin(activeStop)}>Set as origin</button>
                <button
                  type="button"
                  onClick={() => {
                    const index = stops.findIndex((stop) => stop.id === activeStop.id);
                    swapAt(index, index - 1);
                  }}
                >
                  Move earlier
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const index = stops.findIndex((stop) => stop.id === activeStop.id);
                    swapAt(index, index + 1);
                  }}
                >
                  Move later
                </button>
                <a href={stopLink(activeStop)} target="_blank" rel="noreferrer">Open in Google Maps</a>
              </div>
            </section>
          </InfoWindow>
        ) : null}
      </GoogleMap>

      <section className="overlay">
        <header className="overlay-top">
          <div>
            <p className="eyebrow">RouteScout</p>
            <h1>Route on top of the map</h1>
            <p className="origin-copy">
              Optimizing from: {currentPosition ? 'live location' : originCoordinates ? originName : 'no origin selected'} · {travelModeLabel(travelMode)}
            </p>
          </div>
          <div className="totals">
            <div>
              <span>{stops.length}</span>
              <p>Total stops</p>
            </div>
            <div>
              <span>{Math.round(totalRemainingMinutes)}m</span>
              <p>Remaining time</p>
            </div>
            <div>
              <span>{eta}</span>
              <p>ETA last stop</p>
            </div>
          </div>
        </header>

        <section className="origin-picker">
          <div className="origin-picker-head">
            <strong>Choose origin</strong>
            <button type="button" className="ghost" onClick={resetOrigin}>
              Clear origin
            </button>
          </div>

          <div className="origin-actions">
            <button type="button" className="origin-chip" onClick={useLiveLocationAsOrigin} disabled={!currentPosition}>
              {currentPosition ? 'Use live location' : 'Live location unavailable'}
            </button>
            <button type="button" className={`origin-chip ${!originCoordinates && !originStopId ? 'active-origin' : ''}`} onClick={resetOrigin}>
              No origin selected
            </button>
            {stops.map((stop) => (
              <button
                key={stop.id}
                type="button"
                className={`origin-chip ${originName === stop.name ? 'active-origin' : ''}`}
                onClick={() => setAsOrigin(stop)}
              >
                {stop.name}
              </button>
            ))}
          </div>

          <label className="origin-rename">
            Origin label
            <input value={originName} onChange={(event) => setOriginName(event.target.value)} placeholder="No origin selected" />
          </label>
        </section>

        <div className="controls-row">
          <Autocomplete
            onLoad={(instance) => {
              autocompleteRef.current = instance;
            }}
            onPlaceChanged={onPlaceChanged}
            options={{
              fields: ['name', 'formatted_address', 'geometry', 'place_id', 'types', 'photos', 'opening_hours'],
            }}
          >
            <input
              value={searchValue}
              onChange={(event) => setSearchValue(event.target.value)}
              placeholder="Search place or address"
              className="search-input"
            />
          </Autocomplete>

          <label className="time-field">
            Start time
            <input type="time" value={startTime} onChange={(event) => setStartTime(event.target.value)} />
          </label>

          <label className="time-field">
            Transport
            <select value={travelMode} onChange={(event) => setTravelMode(event.target.value as TravelModeOption)}>
              <option value="walking">Walking</option>
              <option value="driving">Driving</option>
              <option value="bicycling">Bicycling</option>
              <option value="transit">Transit</option>
            </select>
          </label>

          <button type="button" className="primary" onClick={optimizeRoute}>Optimize route</button>
          <button type="button" className="ghost" onClick={runApiDiagnostics}>
            {runningApiDiagnostics ? 'Checking APIs...' : 'Run API diagnostic'}
          </button>
          {routeDiffs.length > 0 ? (
            <button type="button" className="ghost" onClick={() => setShowRouteDiffs((value) => !value)}>
              {showRouteDiffs ? 'Hide optimization changes' : 'Show optimization changes'}
            </button>
          ) : null}
          <button type="button" className="ghost" onClick={() => setWalkingMode((value) => !value)}>
            {walkingMode ? 'Stop walking mode' : 'Start walking mode'}
          </button>
          {fullRouteLink ? (
            <a className="ghost" href={fullRouteLink} target="_blank" rel="noreferrer">Open full route in Google Maps</a>
          ) : null}
        </div>

        {showRouteDiffs && routeDiffs.length > 0 ? (
          <section className="diff-box">
            <strong>Optimization changes</strong>
            <ul>
              {routeDiffs.map((diff) => (
                <li key={diff.id}>{diff.message}</li>
              ))}
            </ul>
          </section>
        ) : null}

        {apiDiagnostics ? (
          <details className="diff-box api-diagnostics" open>
            <summary>API diagnostics</summary>
            <div className="api-diagnostics-body">
              <ul>
                <li>Maps JavaScript API: {apiDiagnostics.maps}</li>
                <li>Places API: {apiDiagnostics.places}</li>
                <li>Directions API: {apiDiagnostics.directions}</li>
              </ul>
              <p>{apiDiagnostics.details}</p>
            </div>
          </details>
        ) : null}

        {travelMode === 'transit' && transitLegs.length > 0 ? (
          <section className="diff-box">
            <strong>Transit instructions</strong>
            <div className="transit-list">
              {transitLegs.map((leg, index) => (
                <details key={`${leg.fromName}-${leg.toName}-${index}`} className="transit-leg">
                  <summary>
                    <span>{leg.fromName} to {leg.toName}</span>
                    <span>{leg.minutes}m</span>
                  </summary>
                  <div className="transit-leg-body">
                    <p>{leg.summary}</p>
                    {leg.instructions.length > 0 ? (
                      <ul>
                        {leg.instructions.map((instruction, instructionIndex) => (
                          <li key={`${leg.fromName}-${instructionIndex}`}>{instruction}</li>
                        ))}
                      </ul>
                    ) : (
                      <p>Transit directions unavailable for this leg.</p>
                    )}
                  </div>
                </details>
              ))}
            </div>
          </section>
        ) : null}

        {rerouteHint ? <p className="hint">{rerouteHint}</p> : null}
        {nudgeHint ? <p className="hint">{nudgeHint}</p> : null}

        <ol className="itinerary-list">
          {stops.map((stop, index) => (
            <li
              key={stop.id}
              draggable
              onDragStart={() => setDraggedStopId(stop.id)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => {
                if (draggedStopId) {
                  reorderByDrag(draggedStopId, stop.id);
                }
                setDraggedStopId(null);
              }}
              className={`${stop.checked ? 'checked' : ''} ${highlightStopIds.includes(stop.id) ? 'moved' : ''}`}
            >
              <div className="row-a">
                <span className="pin-number">{index + 1}</span>
                <div>
                  <strong>{stop.name}</strong>
                  <p>{stop.address}</p>
                </div>
                <a href={stopLink(stop)} target="_blank" rel="noreferrer">Navigate</a>
              </div>

              <div className="row-b">
                <label>
                  <input type="checkbox" checked={stop.checked} onChange={() => toggleChecked(stop.id)} />
                  Done
                </label>

                <label>
                  Priority
                  <select
                    value={stop.priority}
                    onChange={(event) => {
                      updateStop(stop.id, { priority: event.target.value as PriorityLevel });
                    }}
                  >
                    <option value="must-do">Must-do</option>
                    <option value="flexible">Flexible</option>
                    <option value="optional">Optional</option>
                  </select>
                </label>

                <label>
                  Visit
                  <input
                    type="number"
                    min={10}
                    step={5}
                    value={stop.durationMinutes}
                    onChange={(event) => {
                      updateStop(stop.id, { durationMinutes: Number(event.target.value) || 10 });
                    }}
                  />
                </label>

                <button type="button" onClick={() => removeStop(stop.id)}>Remove</button>
                <button type="button" onClick={() => setAsOrigin(stop)}>Set as origin</button>
              </div>
            </li>
          ))}
        </ol>

        <footer className="overlay-foot">
          <p>{completedCount} completed</p>
          <p>Tap the map to add unnamed points directly.</p>
          <p>Drag rows to lock a manual order before re-optimizing.</p>
        </footer>
      </section>
    </main>
  );
}
