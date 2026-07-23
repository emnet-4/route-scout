# RouteScout

Smart trip planner for building optimized routes, managing stops, and checking off places on a live map.

## Features

- **Route Optimization**: Automatically optimize your route order based on distance, priority, and travel mode
- **Multiple Travel Modes**: Walking, driving, bicycling, or transit
- **Live Location Tracking**: See your current position and get nudged when you're close to the next stop
- **Stop Prioritization**: Mark stops as must-do, flexible, or optional
- **Google Maps Integration**: Search places, get directions, and view photos/hours
- **Local Persistence**: Your trip data is saved locally in the browser

## Setup

### Prerequisites

- Node.js 16+
- A Google Maps API key with Maps, Places, and Directions APIs enabled

### Installation

```bash
npm install
```

### Environment Variables

Create a `.env.local` file or set the environment variable:

```
VITE_GOOGLE_MAPS_API_KEY=your_google_maps_api_key_here
```

### Development

```bash
npm run dev
```

The app will open at `http://localhost:5173`

### Production Build

```bash
npm run build
npm run preview
```

## Usage

1. Set your starting location (or use live location)
2. Search and add stops to your trip
3. Optimize the route order
4. Check off places as you visit them
5. Open full route in Google Maps for turn-by-turn directions
