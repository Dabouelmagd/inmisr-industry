// ─── maps/maps.service.ts ─────────────────────────────────────────
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma.service';
import axios from 'axios';

export interface LatLng { lat: number; lng: number }

@Injectable()
export class MapsService {
  private readonly logger = new Logger(MapsService.name);
  private readonly apiKey: string;
  private readonly gmBase  = 'https://maps.googleapis.com/maps/api';

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
  ) {
    this.apiKey = config.get('GOOGLE_MAPS_KEY', '');
  }

  // ── GEOCODE address → LatLng ──────────────────────────────────
  async geocode(address: string): Promise<LatLng | null> {
    try {
      const res = await axios.get(`${this.gmBase}/geocode/json`, {
        params: { address: `${address}، مصر`, key: this.apiKey, language: 'ar' },
      });
      if (res.data.status === 'OK' && res.data.results.length > 0) {
        const loc = res.data.results[0].geometry.location;
        return { lat: loc.lat, lng: loc.lng };
      }
      return null;
    } catch (err) {
      this.logger.warn(`Geocode failed for "${address}": ${err.message}`);
      return null;
    }
  }

  // ── REVERSE GEOCODE LatLng → address ─────────────────────────
  async reverseGeocode(lat: number, lng: number): Promise<{ address: string; city: string; zone?: string }> {
    try {
      const res = await axios.get(`${this.gmBase}/geocode/json`, {
        params: { latlng: `${lat},${lng}`, key: this.apiKey, language: 'ar' },
      });
      if (res.data.status === 'OK' && res.data.results.length > 0) {
        const result     = res.data.results[0];
        const components = result.address_components;
        const city       = components.find((c: any) => c.types.includes('administrative_area_level_2'))?.long_name || '';
        return { address: result.formatted_address, city };
      }
      return { address: `${lat}, ${lng}`, city: '' };
    } catch (err) {
      this.logger.warn(`Reverse geocode failed: ${err.message}`);
      return { address: `${lat}, ${lng}`, city: '' };
    }
  }

  // ── DIRECTIONS & DISTANCE ─────────────────────────────────────
  async getRoute(origin: LatLng, destination: LatLng): Promise<{
    distanceKm: number; durationMin: number; polyline: string;
  } | null> {
    try {
      const res = await axios.get(`${this.gmBase}/directions/json`, {
        params: {
          origin:      `${origin.lat},${origin.lng}`,
          destination: `${destination.lat},${destination.lng}`,
          key:          this.apiKey,
          mode:         'driving',
          language:     'ar',
          region:       'EG',
        },
      });
      if (res.data.status === 'OK' && res.data.routes.length > 0) {
        const leg = res.data.routes[0].legs[0];
        return {
          distanceKm: leg.distance.value / 1000,
          durationMin: Math.ceil(leg.duration.value / 60),
          polyline:   res.data.routes[0].overview_polyline.points,
        };
      }
      return null;
    } catch (err) {
      this.logger.warn(`Directions API failed: ${err.message}`);
      return null;
    }
  }

  // ── DISTANCE MATRIX ───────────────────────────────────────────
  async getDistanceMatrix(origins: LatLng[], destinations: LatLng[]): Promise<number[][]> {
    if (!origins.length || !destinations.length) return [];
    try {
      const origStr = origins.map(o => `${o.lat},${o.lng}`).join('|');
      const destStr = destinations.map(d => `${d.lat},${d.lng}`).join('|');
      const res = await axios.get(`${this.gmBase}/distancematrix/json`, {
        params: { origins: origStr, destinations: destStr, key: this.apiKey, mode: 'driving', region: 'EG' },
      });
      if (res.data.status === 'OK') {
        return res.data.rows.map((row: any) =>
          row.elements.map((el: any) => el.status === 'OK' ? el.distance.value / 1000 : 9999)
        );
      }
    } catch (err) {
      this.logger.warn(`Distance matrix failed: ${err.message}`);
    }
    // Fallback: Haversine
    return origins.map(o => destinations.map(d => this.haversine(o, d)));
  }

  // ── PLACES AUTOCOMPLETE for search ───────────────────────────
  async autocomplete(input: string): Promise<{ description: string; placeId: string }[]> {
    try {
      const res = await axios.get(`${this.gmBase}/place/autocomplete/json`, {
        params: {
          input,
          key:         this.apiKey,
          language:    'ar',
          components:  'country:eg',
          types:       'establishment|geocode',
        },
      });
      if (res.data.status === 'OK') {
        return res.data.predictions.slice(0, 5).map((p: any) => ({
          description: p.description,
          placeId:     p.place_id,
        }));
      }
      return [];
    } catch (err) {
      this.logger.warn(`Autocomplete failed: ${err.message}`);
      return [];
    }
  }

  // ── UPDATE company location ───────────────────────────────────
  async updateCompanyLocation(companyId: string, address: string) {
    const coords = await this.geocode(address);
    if (!coords) {
      this.logger.warn(`Could not geocode address for company ${companyId}: "${address}"`);
      return null;
    }
    const { city } = await this.reverseGeocode(coords.lat, coords.lng);
    return this.prisma.geoLocation.upsert({
      where:  { companyId },
      create: {
        companyId,
        addressAr:   address,
        city:        city || address,
        governorate: city || address,
        lat:         coords.lat,
        lng:         coords.lng,
      },
      update: { addressAr: address, lat: coords.lat, lng: coords.lng, city: city || address },
    });
  }

  // ── FIND SUPPLIERS near a point ───────────────────────────────
  async findSuppliersNear(lat: number, lng: number, radiusKm: number, sector?: string) {
    const where: any = { company: { type: 'SUPPLIER', verifiedLevel: { not: 'NONE' } } };
    if (sector) where.company.categories = { some: { category: { sectorCode: sector } } };

    const all = await this.prisma.geoLocation.findMany({
      where,
      include: { company: { include: { subscription: true, categories: { include: { category: true } } } } },
    });

    return all
      .map(loc => ({ ...loc, distanceKm: this.haversine({ lat, lng }, { lat: loc.lat, lng: loc.lng }) }))
      .filter(loc => loc.distanceKm <= radiusKm)
      .sort((a, b) => a.distanceKm - b.distanceKm);
  }

  // ── STATIC MAP URL (for emails/reports) ──────────────────────
  getStaticMapUrl(markers: { lat: number; lng: number; label?: string }[], zoom = 10): string {
    const center = markers.length > 0 ? `${markers[0].lat},${markers[0].lng}` : '30.0444,31.2357';
    const markerParams = markers.slice(0, 10)
      .map(m => `markers=color:red%7Clabel:${m.label || 'S'}%7C${m.lat},${m.lng}`)
      .join('&');
    return `${this.gmBase}/staticmap?center=${center}&zoom=${zoom}&size=600x300&${markerParams}&key=${this.apiKey}`;
  }

  // ── HAVERSINE fallback ────────────────────────────────────────
  haversine(from: LatLng, to: LatLng): number {
    const R = 6371;
    const dLat = (to.lat - from.lat) * Math.PI / 180;
    const dLng = (to.lng - from.lng) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(from.lat * Math.PI / 180) * Math.cos(to.lat * Math.PI / 180) *
              Math.sin(dLng / 2) ** 2;
    return +(6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))).toFixed(2);
  }
}
