// ─── mobile/src/api/client.ts ─────────────────────────────────────
import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';

const BASE_URL = __DEV__
  ? 'http://localhost:3001/api/v1'
  : 'https://api.inmisr.net/api/v1';

export const api = axios.create({
  baseURL: BASE_URL,
  timeout: 30000,
  headers: { 'Content-Type': 'application/json', 'Accept-Language': 'ar' },
});

// Request interceptor — attach JWT
api.interceptors.request.use(async (config) => {
  const token = await AsyncStorage.getItem('access_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Response interceptor — auto-refresh token
api.interceptors.response.use(
  res => res.data?.data ?? res.data,
  async (error) => {
    const original = error.config;
    if (error.response?.status === 401 && !original._retry) {
      original._retry = true;
      const refresh = await AsyncStorage.getItem('refresh_token');
      if (refresh) {
        try {
          const res = await axios.post(`${BASE_URL}/auth/refresh`, { refreshToken: refresh });
          const { accessToken } = res.data.data;
          await AsyncStorage.setItem('access_token', accessToken);
          original.headers.Authorization = `Bearer ${accessToken}`;
          return api(original);
        } catch {
          await AsyncStorage.multiRemove(['access_token', 'refresh_token']);
        }
      }
    }
    const msg = error.response?.data?.message || 'حدث خطأ — يرجى المحاولة مرة أخرى';
    return Promise.reject(new Error(msg));
  },
);

// ── API Methods ───────────────────────────────────────────────────
export const authApi = {
  register: (dto: any)              => api.post('/auth/register', dto),
  login:    (dto: any)              => api.post('/auth/login', dto),
  sendOtp:  (dto: any)              => api.post('/auth/otp/send', dto),
  verifyOtp:(dto: any)              => api.post('/auth/otp/verify', dto),
  refresh:  (token: string)         => api.post('/auth/refresh', { refreshToken: token }),
  logout:   ()                      => api.post('/auth/logout'),
  me:       ()                      => api.get('/auth/me'),
  setup2fa: ()                      => api.post('/auth/2fa/setup'),
  activate2fa: (code: string)       => api.post('/auth/2fa/activate', { code }),
  verify2fa:   (code: string)       => api.post('/auth/2fa/verify', { code }),
};

export const suppliersApi = {
  list:        (params?: any)       => api.get('/suppliers', { params }),
  detail:      (id: string)         => api.get(`/suppliers/${id}`),
  reviews:     (id: string, p?: any)=> api.get(`/reviews/companies/${id}`, { params: p }),
  products:    (id: string)         => api.get(`/products?companyId=${id}`),
};

export const rfqApi = {
  list:        (params?: any)       => api.get('/rfq', { params }),
  create:      (dto: any)           => api.post('/rfq', dto),
  publish:     (id: string)         => api.post(`/rfq/${id}/publish`),
  submitQuote: (id: string, dto: any)=> api.post(`/rfq/${id}/quote`, dto),
  acceptQuote: (rfqId: string, qId: string) => api.post(`/rfq/${rfqId}/accept/${qId}`),
};

export const ordersApi = {
  list:        (params?: any)       => api.get('/orders', { params }),
  detail:      (id: string)         => api.get(`/orders/${id}`),
  fundEscrow:  (id: string, token: string) => api.post(`/escrow/${id}/fund`, { gatewayToken: token }),
  release:     (id: string)         => api.post(`/escrow/${id}/release`),
  dispute:     (id: string, dto: any)=> api.post(`/escrow/${id}/dispute`, dto),
};

export const messagesApi = {
  thread:      (orderId: string)    => api.get(`/messages/orders/${orderId}`),
  send:        (orderId: string, content: string) => api.post(`/messages/orders/${orderId}`, { content }),
  markRead:    (orderId: string)    => api.patch(`/messages/orders/${orderId}/read`),
};

export const notificationsApi = {
  list:        (params?: any)       => api.get('/notifications', { params }),
  markRead:    (id: string)         => api.patch(`/notifications/${id}/read`),
  markAllRead: ()                   => api.patch('/notifications/read-all'),
};

export const geoApi = {
  zones:       ()                   => api.get('/geo/zones'),
  suppliers:   (params: any)        => api.get('/geo/suppliers', { params }),
  shipping:    (params: any)        => api.get('/geo/shipping-estimate', { params }),
};

export const loyaltyApi = {
  summary:     ()                   => api.get('/loyalty/summary'),
  tiers:       ()                   => api.get('/loyalty/tiers'),
  redeem:      (dto: any)           => api.post('/loyalty/redeem', dto),
};

// ─── mobile/src/store/auth.store.ts ──────────────────────────────
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { authApi } from '../api/client';

interface AuthState {
  user:            any | null;
  accessToken:     string | null;
  refreshToken:    string | null;
  fcmToken:        string | null;
  isAuthenticated: boolean;
  isLoading:       boolean;
  login:           (dto: { emailOrPhone: string; password?: string }) => Promise<void>;
  logout:          () => Promise<void>;
  setFcmToken:     (token: string) => Promise<void>;
  refreshSession:  () => Promise<void>;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null, accessToken: null, refreshToken: null,
      fcmToken: null, isAuthenticated: false, isLoading: false,

      login: async (dto) => {
        set({ isLoading: true });
        try {
          const res = await authApi.login(dto) as any;
          await AsyncStorage.setItem('access_token',  res.accessToken);
          await AsyncStorage.setItem('refresh_token', res.refreshToken);
          set({
            user: res.user, accessToken: res.accessToken,
            refreshToken: res.refreshToken, isAuthenticated: true, isLoading: false,
          });
        } catch (err) {
          set({ isLoading: false });
          throw err;
        }
      },

      logout: async () => {
        await authApi.logout().catch(() => {});
        await AsyncStorage.multiRemove(['access_token', 'refresh_token']);
        set({ user: null, accessToken: null, refreshToken: null, isAuthenticated: false });
      },

      setFcmToken: async (token) => {
        set({ fcmToken: token });
        // Register token with backend
        await api.post('/auth/fcm-token', { token }).catch(() => {});
      },

      refreshSession: async () => {
        const { refreshToken } = get();
        if (!refreshToken) return;
        try {
          const res = await authApi.refresh(refreshToken) as any;
          await AsyncStorage.setItem('access_token', res.accessToken);
          set({ accessToken: res.accessToken });
        } catch {
          await get().logout();
        }
      },
    }),
    {
      name:    'inmisr-auth',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ user: state.user, fcmToken: state.fcmToken }),
    },
  ),
);

// ─── mobile/src/screens/LoginScreen.tsx ──────────────────────────
import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, Image, KeyboardAvoidingView, Alert, ActivityIndicator,
} from 'react-native';

export function LoginScreen({ navigation }: any) {
  const [emailOrPhone, setEmailOrPhone] = useState('');
  const [password, setPassword]         = useState('');
  const [loading, setLoading]           = useState(false);
  const { login } = useAuthStore();

  const handleLogin = async () => {
    if (!emailOrPhone.trim()) {
      Alert.alert('خطأ', 'يرجى إدخال البريد الإلكتروني أو رقم الهاتف');
      return;
    }
    setLoading(true);
    try {
      await login({ emailOrPhone, password: password || undefined });
    } catch (err: any) {
      Alert.alert('خطأ في الدخول', err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.container} behavior="padding">
      <View style={styles.header}>
        <Text style={styles.logo}>إن مصر للصناعة</Text>
        <Text style={styles.sub}>B2B Industrial Marketplace</Text>
        <View style={styles.flag}>
          <View style={[styles.flagStripe, { backgroundColor: '#CE1126' }]} />
          <View style={[styles.flagStripe, { backgroundColor: '#FFFFFF' }]} />
          <View style={[styles.flagStripe, { backgroundColor: '#111' }]} />
        </View>
      </View>

      <View style={styles.form}>
        <Text style={styles.label}>البريد الإلكتروني أو رقم الهاتف</Text>
        <TextInput
          style={styles.input}
          value={emailOrPhone}
          onChangeText={setEmailOrPhone}
          placeholder="0101234567 أو email@company.com"
          keyboardType="email-address"
          autoCapitalize="none"
          textAlign="right"
        />

        <Text style={styles.label}>كلمة المرور</Text>
        <TextInput
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          placeholder="••••••••"
          secureTextEntry
          textAlign="right"
        />

        <TouchableOpacity
          style={[styles.btn, loading && styles.btnDisabled]}
          onPress={handleLogin}
          disabled={loading}
        >
          {loading
            ? <ActivityIndicator color="#FFFFFF" />
            : <Text style={styles.btnText}>تسجيل الدخول</Text>
          }
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.otpBtn}
          onPress={() => navigation.navigate('OTP', { mode: 'login' })}
        >
          <Text style={styles.otpBtnText}>📱 دخول برمز OTP</Text>
        </TouchableOpacity>

        <TouchableOpacity onPress={() => navigation.navigate('Register')}>
          <Text style={styles.link}>ليس لديك حساب؟ سجّل الآن</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container:   { flex: 1, backgroundColor: '#0D0D0D' },
  header:      { alignItems: 'center', paddingTop: 80, paddingBottom: 40 },
  logo:        { fontSize: 28, fontWeight: '700', color: '#FFFFFF', marginBottom: 6 },
  sub:         { fontSize: 13, color: '#888888' },
  flag:        { flexDirection: 'row', width: 48, height: 8, borderRadius: 4, overflow: 'hidden', marginTop: 12 },
  flagStripe:  { flex: 1 },
  form:        { flex: 1, backgroundColor: '#F8F8F8', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24 },
  label:       { fontSize: 13, fontWeight: '600', color: '#333', marginBottom: 6, marginTop: 14, textAlign: 'right' },
  input:       { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E0E0E0', borderRadius: 10, padding: 12, fontSize: 14, color: '#1A1A1A' },
  btn:         { backgroundColor: '#CE1126', borderRadius: 10, padding: 14, alignItems: 'center', marginTop: 24 },
  btnDisabled: { opacity: 0.7 },
  btnText:     { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  otpBtn:      { borderWidth: 1, borderColor: '#CE1126', borderRadius: 10, padding: 13, alignItems: 'center', marginTop: 10 },
  otpBtnText:  { color: '#CE1126', fontSize: 14, fontWeight: '600' },
  link:        { textAlign: 'center', color: '#CE1126', marginTop: 20, fontSize: 13 },
});

// ─── mobile/package.json ──────────────────────────────────────────
export const MOBILE_PACKAGE = {
  name: 'inmisr-mobile',
  version: '1.0.0',
  main: 'index.js',
  scripts: {
    android: 'react-native run-android',
    ios:     'react-native run-ios',
    start:   'react-native start',
    test:    'jest',
    build:   'cd android && ./gradlew assembleRelease',
  },
  dependencies: {
    'react':                          '18.2.0',
    'react-native':                   '0.73.0',
    '@react-navigation/native':       '^6.1.0',
    '@react-navigation/native-stack': '^6.9.0',
    '@react-navigation/bottom-tabs':  '^6.5.0',
    '@tanstack/react-query':          '^5.0.0',
    'zustand':                        '^4.4.0',
    'axios':                          '^1.5.0',
    '@react-native-async-storage/async-storage': '^1.21.0',
    '@react-native-firebase/app':     '^18.0.0',
    '@react-native-firebase/messaging': '^18.0.0',
    'react-native-paper':             '^5.11.0',
    'react-native-maps':              '^1.8.0',
    'react-native-camera':            '^4.2.1',
    'react-native-qrcode-svg':        '^6.2.0',
    'react-native-vector-icons':      '^10.0.0',
    'react-native-linear-gradient':   '^2.8.3',
    'react-native-image-picker':      '^7.0.0',
    'socket.io-client':               '^4.6.0',
    '@stripe/stripe-react-native':    '^0.35.0',
  },
};
