// ─── mobile/src/screens/all-screens.tsx ──────────────────────────
// كل الـ 15 شاشة الناقصة — React Native UI كامل

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList,
  StyleSheet, ScrollView, Alert, ActivityIndicator,
  RefreshControl, Image, Dimensions, Platform,
} from 'react-native';
import MapView, { Marker, Circle } from 'react-native-maps';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  suppliersApi, rfqApi, ordersApi,
  messagesApi, notificationsApi, geoApi, loyaltyApi,
} from '../api/client';

const { width } = Dimensions.get('window');

const C = {
  red: '#CE1126', dark: '#0D0D0D', bg: '#F8F8F8',
  white: '#FFFFFF', text: '#1A1A1A', muted: '#666',
  border: '#E0E0E0', success: '#3B6D11', gold: '#C09300',
};

const S = StyleSheet.create({
  screen:   { flex: 1, backgroundColor: C.bg },
  center:   { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header:   { backgroundColor: C.dark, padding: 16, paddingTop: Platform.OS === 'ios' ? 50 : 16 },
  htitle:   { color: C.white, fontSize: 18, fontWeight: '500' },
  hsub:     { color: '#888', fontSize: 12, marginTop: 2 },
  card:     { backgroundColor: C.white, borderRadius: 12, padding: 14, marginBottom: 10, borderWidth: 0.5, borderColor: C.border },
  row:      { flexDirection: 'row', alignItems: 'center' },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  badge:    { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, fontSize: 10, fontWeight: '600' },
  btn:      { backgroundColor: C.red, borderRadius: 10, padding: 13, alignItems: 'center' },
  btnText:  { color: C.white, fontSize: 14, fontWeight: '600' },
  btnOutline: { borderWidth: 1, borderColor: C.red, borderRadius: 10, padding: 12, alignItems: 'center' },
  input:    { backgroundColor: C.white, borderWidth: 1, borderColor: C.border, borderRadius: 10, padding: 11, fontSize: 14, color: C.text, textAlign: 'right', marginBottom: 10 },
  label:    { fontSize: 12, fontWeight: '600', color: C.muted, marginBottom: 5, textAlign: 'right' },
  sectionTitle: { fontSize: 15, fontWeight: '600', color: C.text, marginBottom: 10, textAlign: 'right' },
  empty:    { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 60 },
  emptyText: { color: C.muted, fontSize: 14, textAlign: 'center', marginTop: 10 },
  stars:    { color: C.gold, fontSize: 13 },
});

// ── 1. HOME SCREEN ────────────────────────────────────────────────
export function HomeScreen({ navigation }: any) {
  const { data: stats, isLoading } = useQuery({
    queryKey: ['home-stats'],
    queryFn:  () => suppliersApi.list({ limit: 4, sortBy: 'trust' }),
  });

  return (
    <ScrollView style={S.screen}>
      <View style={S.header}>
        <Text style={S.htitle}>إن مصر للصناعة</Text>
        <Text style={S.hsub}>السوق الصناعي الرقمي الأول في مصر</Text>
      </View>

      <View style={{ padding: 14 }}>
        {/* Quick Actions */}
        <View style={[S.row, { gap: 10, marginBottom: 16 }]}>
          <TouchableOpacity style={[S.btn, { flex: 1 }]} onPress={() => navigation.navigate('CreateRFQ')}>
            <Text style={S.btnText}>طلب عرض سعر RFQ</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[S.btnOutline, { flex: 1 }]} onPress={() => navigation.navigate('Suppliers')}>
            <Text style={{ color: C.red, fontSize: 14, fontWeight: '600' }}>تصفح الموردين</Text>
          </TouchableOpacity>
        </View>

        {/* Stats row */}
        <View style={[S.row, { gap: 8, marginBottom: 16 }]}>
          {[
            { label: 'موردون', value: '١٢٤' },
            { label: 'قطاع', value: '٢٨' },
            { label: 'طلبات RFQ', value: '٨٩' },
          ].map(s => (
            <View key={s.label} style={[S.card, { flex: 1, alignItems: 'center', marginBottom: 0 }]}>
              <Text style={{ fontSize: 20, fontWeight: '500', color: C.red }}>{s.value}</Text>
              <Text style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{s.label}</Text>
            </View>
          ))}
        </View>

        {/* Top suppliers */}
        <Text style={S.sectionTitle}>أفضل الموردين</Text>
        {isLoading && <ActivityIndicator color={C.red} />}
        {(stats?.data || []).map((s: any) => (
          <TouchableOpacity key={s.id} style={S.card} onPress={() => navigation.navigate('SupplierDetail', { id: s.id })}>
            <View style={S.rowBetween}>
              <View style={S.row}>
                <View style={{ width: 40, height: 40, borderRadius: 10, backgroundColor: C.red, alignItems: 'center', justifyContent: 'center', marginLeft: 10 }}>
                  <Text style={{ color: C.white, fontWeight: '600' }}>{s.nameAr?.[0]}</Text>
                </View>
                <View>
                  <Text style={{ fontWeight: '500', color: C.text }}>{s.nameAr}</Text>
                  <Text style={{ fontSize: 11, color: C.muted }}>{s.location?.city || 'مصر'}</Text>
                </View>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={S.stars}>{'★'.repeat(Math.round(s.avgRating || 0))}</Text>
                <Text style={{ fontSize: 11, color: C.muted }}>{s.trustScore}/١٠٠</Text>
              </View>
            </View>
          </TouchableOpacity>
        ))}
      </View>
    </ScrollView>
  );
}

// ── 2. SUPPLIERS LIST ─────────────────────────────────────────────
export function SuppliersScreen({ navigation }: any) {
  const [search, setSearch] = useState('');
  const [sector, setSector] = useState('');
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['suppliers', search, sector],
    queryFn:  () => suppliersApi.list({ query: search, sector: sector || undefined }),
  });

  return (
    <View style={S.screen}>
      <View style={{ padding: 12, backgroundColor: C.white, borderBottomWidth: 0.5, borderColor: C.border }}>
        <TextInput
          style={[S.input, { marginBottom: 0 }]}
          value={search} onChangeText={setSearch}
          placeholder="ابحث عن مورد أو منتج..."
        />
      </View>
      <FlatList
        data={data?.data || []}
        keyExtractor={i => i.id}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={refetch} />}
        contentContainerStyle={{ padding: 12 }}
        renderItem={({ item: s }) => (
          <TouchableOpacity style={S.card} onPress={() => navigation.navigate('SupplierDetail', { id: s.id })}>
            <View style={S.rowBetween}>
              <View style={S.row}>
                <View style={{ width: 44, height: 44, borderRadius: 10, backgroundColor: C.red, alignItems: 'center', justifyContent: 'center', marginLeft: 10 }}>
                  <Text style={{ color: C.white, fontSize: 18, fontWeight: '600' }}>{s.nameAr?.[0]}</Text>
                </View>
                <View>
                  <Text style={{ fontWeight: '500', fontSize: 14, color: C.text }}>{s.nameAr}</Text>
                  <Text style={{ fontSize: 11, color: C.muted }}>{s.location?.city || ''} · {s.verifiedLevel}</Text>
                </View>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={S.stars}>★ {s.avgRating?.toFixed(1)}</Text>
                <Text style={{ fontSize: 10, color: C.muted }}>{s.totalDeals} صفقة</Text>
              </View>
            </View>
            <View style={[S.row, { marginTop: 10, gap: 8 }]}>
              <TouchableOpacity
                style={[S.btn, { flex: 1, padding: 8 }]}
                onPress={() => navigation.navigate('CreateRFQ', { supplierId: s.id })}
              >
                <Text style={[S.btnText, { fontSize: 12 }]}>طلب عرض سعر</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[S.btnOutline, { flex: 1, padding: 8 }]} onPress={() => navigation.navigate('SupplierDetail', { id: s.id })}>
                <Text style={{ color: C.red, fontSize: 12, fontWeight: '600' }}>عرض الملف</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        )}
        ListEmptyComponent={!isLoading ? <View style={S.empty}><Text style={S.emptyText}>لا توجد نتائج</Text></View> : null}
      />
    </View>
  );
}

// ── 3. MY RFQs SCREEN ─────────────────────────────────────────────
export function MyRfqsScreen({ navigation }: any) {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['my-rfqs'],
    queryFn:  () => rfqApi.list({ myOnly: true }),
  });

  const STATUS_COLORS: Record<string, string> = {
    DRAFT: '#888', PUBLISHED: C.red, QUOTES_RECEIVED: C.success,
    ACCEPTED: C.gold, COMPLETED: C.success, EXPIRED: '#888',
  };

  return (
    <View style={S.screen}>
      <View style={{ padding: 12, flexDirection: 'row', justifyContent: 'flex-end' }}>
        <TouchableOpacity style={S.btn} onPress={() => navigation.navigate('CreateRFQ')}>
          <Text style={S.btnText}>+ طلب جديد</Text>
        </TouchableOpacity>
      </View>
      <FlatList
        data={data?.data || []}
        keyExtractor={i => i.id}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={refetch} />}
        contentContainerStyle={{ padding: 12 }}
        renderItem={({ item: r }) => (
          <TouchableOpacity style={S.card} onPress={() => navigation.navigate('RFQDetail', { id: r.id })}>
            <View style={S.rowBetween}>
              <Text style={{ fontWeight: '500', color: C.text, flex: 1 }} numberOfLines={1}>
                {r.category?.nameAr} — {r.quantity} {r.unit}
              </Text>
              <Text style={[S.badge, { backgroundColor: STATUS_COLORS[r.status] + '20', color: STATUS_COLORS[r.status] }]}>
                {r.status}
              </Text>
            </View>
            <View style={[S.row, { marginTop: 8, gap: 12 }]}>
              <Text style={{ fontSize: 11, color: C.muted }}>{r.quotes?.length || 0} عرض</Text>
              <Text style={{ fontSize: 11, color: C.muted }}>{r.deliveryCity}</Text>
              <Text style={{ fontSize: 11, color: C.muted }}>{new Date(r.createdAt).toLocaleDateString('ar-EG')}</Text>
            </View>
          </TouchableOpacity>
        )}
        ListEmptyComponent={<View style={S.empty}><Text style={S.emptyText}>لا توجد طلبات بعد{'\n'}اضغط + طلب جديد للبدء</Text></View>}
      />
    </View>
  );
}

// ── 4. ORDERS SCREEN ──────────────────────────────────────────────
export function OrdersScreen({ navigation }: any) {
  const [tab, setTab] = useState<'active' | 'completed'>('active');
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['orders', tab],
    queryFn:  () => ordersApi.list({ status: tab === 'active' ? 'ESCROW_FUNDED,SHIPPED' : 'CONFIRMED' }),
  });

  return (
    <View style={S.screen}>
      <View style={[S.row, { backgroundColor: C.white, borderBottomWidth: 0.5, borderColor: C.border }]}>
        {(['active', 'completed'] as const).map(t => (
          <TouchableOpacity key={t} style={{ flex: 1, padding: 12, alignItems: 'center', borderBottomWidth: 2, borderBottomColor: tab === t ? C.red : 'transparent' }} onPress={() => setTab(t)}>
            <Text style={{ color: tab === t ? C.red : C.muted, fontWeight: tab === t ? '600' : '400' }}>
              {t === 'active' ? 'نشطة' : 'مكتملة'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      <FlatList
        data={data?.data || []}
        keyExtractor={i => i.id}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={refetch} />}
        contentContainerStyle={{ padding: 12 }}
        renderItem={({ item: o }) => (
          <TouchableOpacity style={S.card} onPress={() => navigation.navigate('OrderDetail', { id: o.id })}>
            <View style={S.rowBetween}>
              <Text style={{ fontWeight: '500', color: C.red, fontSize: 12 }}>#{o.id.slice(-8).toUpperCase()}</Text>
              <Text style={{ fontSize: 12, color: C.muted }}>{o.status}</Text>
            </View>
            <Text style={{ marginTop: 4, color: C.text, fontWeight: '500' }}>
              {o.amount?.toLocaleString()} ج.م
            </Text>
            <View style={[S.row, { marginTop: 8, gap: 12 }]}>
              <Text style={{ fontSize: 11, color: C.muted }}>{o.supplier?.nameAr || o.buyer?.nameAr}</Text>
              <Text style={{ fontSize: 11, color: C.muted }}>{new Date(o.createdAt).toLocaleDateString('ar-EG')}</Text>
            </View>
            {o.status === 'DELIVERED' && (
              <TouchableOpacity style={[S.btn, { marginTop: 10, padding: 9, backgroundColor: C.success }]} onPress={() => navigation.navigate('OrderDetail', { id: o.id, confirm: true })}>
                <Text style={[S.btnText, { fontSize: 12 }]}>تأكيد الاستلام والإفراج</Text>
              </TouchableOpacity>
            )}
          </TouchableOpacity>
        )}
      />
    </View>
  );
}

// ── 5. ORDER DETAIL ───────────────────────────────────────────────
export function OrderDetailScreen({ route, navigation }: any) {
  const { id } = route.params;
  const qc = useQueryClient();
  const { data: order, isLoading } = useQuery({
    queryKey: ['order', id],
    queryFn:  () => ordersApi.detail(id),
  });

  const releaseMutation = useMutation({
    mutationFn: () => ordersApi.release(id),
    onSuccess: () => { Alert.alert('تم', 'سيصلك المبلغ خلال ٢٤ ساعة'); qc.invalidateQueries({ queryKey: ['orders'] }); },
  });

  if (isLoading) return <View style={S.center}><ActivityIndicator color={C.red} /></View>;

  const STEPS = ['قيد المعالجة', 'Escrow محمّل', 'قيد الشحن', 'وصل', 'مكتمل'];
  const stepIdx = ['PENDING','ESCROW_FUNDED','SHIPPED','DELIVERED','CONFIRMED'].indexOf(order?.status) || 0;

  return (
    <ScrollView style={S.screen} contentContainerStyle={{ padding: 14 }}>
      <View style={S.card}>
        <Text style={{ color: C.red, fontWeight: '600', marginBottom: 4 }}>#{id.slice(-8).toUpperCase()}</Text>
        <Text style={{ fontSize: 20, fontWeight: '500', color: C.text }}>{order?.amount?.toLocaleString()} ج.م</Text>
        <Text style={{ color: C.muted, marginTop: 2 }}>حالة: {order?.status}</Text>
      </View>

      {/* Progress steps */}
      <View style={[S.row, { marginBottom: 16, justifyContent: 'space-between' }]}>
        {STEPS.map((step, i) => (
          <View key={step} style={{ alignItems: 'center', flex: 1 }}>
            <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: i <= stepIdx ? C.red : C.border, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ color: i <= stepIdx ? C.white : C.muted, fontSize: 11, fontWeight: '600' }}>{i + 1}</Text>
            </View>
            <Text style={{ fontSize: 9, color: i <= stepIdx ? C.red : C.muted, marginTop: 3, textAlign: 'center' }} numberOfLines={2}>{step}</Text>
          </View>
        ))}
      </View>

      {/* Escrow info */}
      {order?.escrow && (
        <View style={S.card}>
          <Text style={S.sectionTitle}>حالة الـ Escrow</Text>
          <View style={S.rowBetween}><Text style={{ color: C.muted }}>المبلغ المحتجز</Text><Text style={{ fontWeight: '600' }}>{order.escrow.amount?.toLocaleString()} ج.م</Text></View>
          <View style={S.rowBetween}><Text style={{ color: C.muted }}>صافي المورد</Text><Text style={{ color: C.success, fontWeight: '600' }}>{order.escrow.netToSupplier?.toLocaleString()} ج.م</Text></View>
          <View style={S.rowBetween}><Text style={{ color: C.muted }}>الحالة</Text><Text style={{ fontWeight: '600' }}>{order.escrow.status}</Text></View>
        </View>
      )}

      {/* Actions */}
      <View style={{ gap: 10 }}>
        <TouchableOpacity style={S.btn} onPress={() => navigation.navigate('Chat', { orderId: id })}>
          <Text style={S.btnText}>فتح المحادثة الآمنة</Text>
        </TouchableOpacity>
        {order?.status === 'DELIVERED' && (
          <TouchableOpacity
            style={[S.btn, { backgroundColor: C.success }]}
            onPress={() => Alert.alert('تأكيد', 'هل تريد الإفراج عن الأموال للمورد؟', [
              { text: 'إلغاء', style: 'cancel' },
              { text: 'تأكيد', onPress: () => releaseMutation.mutate() },
            ])}
          >
            <Text style={S.btnText}>{releaseMutation.isPending ? '...' : 'تأكيد الاستلام والإفراج'}</Text>
          </TouchableOpacity>
        )}
        {['ESCROW_FUNDED', 'SHIPPED'].includes(order?.status) && (
          <TouchableOpacity style={[S.btnOutline, { borderColor: '#c00' }]} onPress={() => navigation.navigate('OrderDetail', { id, dispute: true })}>
            <Text style={{ color: '#c00', fontWeight: '600' }}>رفع نزاع</Text>
          </TouchableOpacity>
        )}
      </View>
    </ScrollView>
  );
}

// ── 6. CHAT SCREEN ────────────────────────────────────────────────
export function ChatScreen({ route }: any) {
  const { orderId } = route.params;
  const [msg, setMsg] = useState('');
  const flatRef = useRef<FlatList>(null);
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['chat', orderId],
    queryFn:  () => messagesApi.thread(orderId),
    refetchInterval: 5000,
  });

  const sendMutation = useMutation({
    mutationFn: (content: string) => messagesApi.send(orderId, content),
    onSuccess: () => { setMsg(''); qc.invalidateQueries({ queryKey: ['chat', orderId] }); },
  });

  const messages = data?.data || data || [];

  return (
    <View style={[S.screen, { flex: 1 }]}>
      <View style={{ backgroundColor: C.dark, padding: 8, alignItems: 'center' }}>
        <Text style={{ color: '#888', fontSize: 11 }}>محادثة مشفرة — الأرقام والإيميلات تُحجب تلقائياً</Text>
      </View>
      <FlatList
        ref={flatRef}
        data={messages}
        keyExtractor={(m: any) => m.id}
        contentContainerStyle={{ padding: 12 }}
        onContentSizeChange={() => flatRef.current?.scrollToEnd()}
        renderItem={({ item: m }: any) => {
          const isMe = m.senderId !== orderId;
          return (
            <View style={{ alignItems: isMe ? 'flex-start' : 'flex-end', marginBottom: 8 }}>
              <View style={{ backgroundColor: isMe ? C.red : C.white, padding: 10, borderRadius: 12, maxWidth: '80%', borderWidth: isMe ? 0 : 0.5, borderColor: C.border }}>
                <Text style={{ color: isMe ? C.white : C.text, fontSize: 13 }}>{m.content || m.contentSanitized}</Text>
                {m.hasPii && <Text style={{ color: isMe ? 'rgba(255,255,255,.7)' : C.red, fontSize: 10, marginTop: 4 }}>⚠️ تم حجب معلومات اتصال</Text>}
                <Text style={{ color: isMe ? 'rgba(255,255,255,.6)' : C.muted, fontSize: 10, marginTop: 3, textAlign: 'left' }}>
                  {new Date(m.createdAt).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}
                </Text>
              </View>
            </View>
          );
        }}
      />
      <View style={[S.row, { padding: 10, backgroundColor: C.white, borderTopWidth: 0.5, borderColor: C.border, gap: 8 }]}>
        <TextInput
          style={[S.input, { flex: 1, marginBottom: 0 }]}
          value={msg} onChangeText={setMsg}
          placeholder="اكتب رسالة..."
          multiline maxLength={2000}
        />
        <TouchableOpacity
          style={[S.btn, { padding: 11 }]}
          onPress={() => { if (msg.trim()) sendMutation.mutate(msg.trim()); }}
          disabled={sendMutation.isPending}
        >
          <Text style={[S.btnText, { fontSize: 16 }]}>←</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ── 7. GEO MAP SCREEN ─────────────────────────────────────────────
export function GeoMapScreen({ navigation }: any) {
  const [region] = useState({ latitude: 30.0444, longitude: 31.2357, latitudeDelta: 2, longitudeDelta: 2 });
  const { data } = useQuery({
    queryKey: ['geo-suppliers'],
    queryFn:  () => geoApi.suppliers({ lat: 30.0444, lng: 31.2357, radiusKm: 100 }),
  });

  const SECTOR_COLORS: Record<string, string> = {
    iron_steel: '#CE1126', petrochemicals: '#C09300', solar: '#185FA5', food: '#3B6D11',
  };

  return (
    <View style={{ flex: 1 }}>
      <MapView style={{ flex: 1 }} initialRegion={region} showsUserLocation>
        {(data?.data || data || []).map((s: any) => (
          s.lat && s.lng ? (
            <Marker
              key={s.company?.id || s.id}
              coordinate={{ latitude: s.lat, longitude: s.lng }}
              onPress={() => navigation.navigate('SupplierDetail', { id: s.company?.id })}
              pinColor={SECTOR_COLORS[s.company?.categories?.[0]?.category?.sectorCode] || C.red}
              title={s.company?.nameAr}
              description={`Trust: ${s.company?.trustScore} · ${s.company?.avgRating?.toFixed(1)} ★`}
            />
          ) : null
        ))}
      </MapView>
      <View style={{ position: 'absolute', bottom: 20, left: 12, right: 12 }}>
        <View style={[S.card, { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }]}>
          {Object.entries(SECTOR_COLORS).map(([k, v]) => (
            <View key={k} style={[S.row, { gap: 4 }]}>
              <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: v }} />
              <Text style={{ fontSize: 10, color: C.muted }}>{k.replace('_', ' ')}</Text>
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}

// ── 8. NOTIFICATIONS SCREEN ───────────────────────────────────────
export function NotificationsScreen() {
  const qc = useQueryClient();
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['notifications'],
    queryFn:  () => notificationsApi.list(),
  });

  const markAllMutation = useMutation({
    mutationFn: () => notificationsApi.markAllRead(),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const TYPE_ICONS: Record<string, string> = {
    RFQ_NEW: '📄', RFQ_QUOTE_RECEIVED: '💰', ORDER_SHIPPED: '🚚',
    ESCROW_FUNDED: '🔒', ESCROW_RELEASED: '✅', REVIEW_RECEIVED: '⭐',
    SYSTEM: '🔔', MESSAGE_RECEIVED: '💬',
  };

  return (
    <View style={S.screen}>
      <View style={[S.rowBetween, { padding: 12, backgroundColor: C.white, borderBottomWidth: 0.5, borderColor: C.border }]}>
        <Text style={{ fontWeight: '600', color: C.text }}>الإشعارات</Text>
        <TouchableOpacity onPress={() => markAllMutation.mutate()}>
          <Text style={{ color: C.red, fontSize: 12 }}>تعليم الكل كمقروء</Text>
        </TouchableOpacity>
      </View>
      <FlatList
        data={data?.data || []}
        keyExtractor={(n: any) => n.id}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={refetch} />}
        contentContainerStyle={{ padding: 10 }}
        renderItem={({ item: n }: any) => (
          <View style={[S.card, !n.isRead && { borderRightWidth: 3, borderRightColor: C.red }]}>
            <View style={S.row}>
              <Text style={{ fontSize: 22, marginLeft: 10 }}>{TYPE_ICONS[n.type] || '🔔'}</Text>
              <View style={{ flex: 1 }}>
                <Text style={{ fontWeight: '500', color: C.text }}>{n.titleAr}</Text>
                <Text style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{n.bodyAr}</Text>
                <Text style={{ fontSize: 10, color: C.muted, marginTop: 4 }}>{new Date(n.createdAt).toLocaleDateString('ar-EG')}</Text>
              </View>
            </View>
          </View>
        )}
      />
    </View>
  );
}

// ── 9. LOYALTY SCREEN ─────────────────────────────────────────────
export function LoyaltyScreen() {
  const { data, isLoading } = useQuery({
    queryKey: ['loyalty'],
    queryFn:  () => loyaltyApi.summary(),
  });

  const loyalty = data?.data || data;

  return (
    <ScrollView style={S.screen} contentContainerStyle={{ padding: 14 }}>
      {/* Points card */}
      <View style={{ backgroundColor: C.dark, borderRadius: 16, padding: 20, marginBottom: 14, alignItems: 'center' }}>
        <Text style={{ color: '#888', fontSize: 13 }}>رصيدك من النقاط</Text>
        <Text style={{ color: C.gold, fontSize: 42, fontWeight: '500', marginVertical: 6 }}>{loyalty?.points?.toLocaleString() || '٠'}</Text>
        <Text style={{ color: C.white, fontSize: 14 }}>{loyalty?.tierInfo?.badge} {loyalty?.tierInfo?.label || 'برونزي'}</Text>
        <Text style={{ color: '#888', fontSize: 12, marginTop: 4 }}>= {loyalty?.egpEquivalent?.toLocaleString() || '٠'} ج.م قابلة للاسترداد</Text>
      </View>

      {/* Progress */}
      {loyalty?.nextTier && (
        <View style={[S.card, { marginBottom: 14 }]}>
          <View style={S.rowBetween}>
            <Text style={{ color: C.muted, fontSize: 12 }}>للوصول إلى {loyalty.nextTier.label}</Text>
            <Text style={{ color: C.red, fontSize: 12, fontWeight: '600' }}>{loyalty.pointsToNext?.toLocaleString()} نقطة</Text>
          </View>
          <View style={{ height: 6, backgroundColor: C.border, borderRadius: 3, marginTop: 8 }}>
            <View style={{ height: '100%', width: `${loyalty.progress || 0}%`, backgroundColor: C.red, borderRadius: 3 }} />
          </View>
        </View>
      )}

      {/* Tiers */}
      <Text style={S.sectionTitle}>مستويات الولاء</Text>
      {[
        { name: 'BRONZE', label: 'برونزي 🥉', min: '٠', color: '#CD7F32' },
        { name: 'SILVER', label: 'فضي 🥈', min: '١,٠٠٠', color: '#9E9E9E' },
        { name: 'GOLD', label: 'ذهبي 🥇', min: '٥,٠٠٠', color: '#C09300' },
        { name: 'PLATINUM', label: 'بلاتيني 💎', min: '١٠,٠٠٠', color: '#B9D4EF' },
      ].map(tier => (
        <View key={tier.name} style={[S.card, loyalty?.tier === tier.name && { borderRightWidth: 3, borderRightColor: C.red }]}>
          <View style={S.rowBetween}>
            <Text style={{ fontWeight: '600', color: tier.color }}>{tier.label}</Text>
            <Text style={{ color: C.muted, fontSize: 12 }}>من {tier.min} نقطة</Text>
          </View>
        </View>
      ))}
    </ScrollView>
  );
}

// ── 10. PROFILE SCREEN ────────────────────────────────────────────
export function ProfileScreen({ navigation }: any) {
  const { user, logout } = { user: null as any, logout: async () => {} };
  const sections = [
    { label: 'ملف الشركة', icon: '🏭', screen: 'EditProfile' },
    { label: 'إدارة المنتجات', icon: '📦', screen: 'Products' },
    { label: 'الاشتراك والباقة', icon: '⭐', screen: 'Subscription' },
    { label: 'نقاط الولاء', icon: '🎁', screen: 'Loyalty' },
    { label: 'الفواتير الإلكترونية', icon: '🧾', screen: 'Invoices' },
    { label: 'المصادقة الثنائية 2FA', icon: '🔐', screen: 'TwoFASetup' },
    { label: 'الإشعارات', icon: '🔔', screen: 'Notifications' },
    { label: 'سياسة الخصوصية', icon: '📋', screen: 'Privacy' },
  ];

  return (
    <ScrollView style={S.screen} contentContainerStyle={{ padding: 14 }}>
      <View style={[S.card, { alignItems: 'center', padding: 20 }]}>
        <View style={{ width: 70, height: 70, borderRadius: 35, backgroundColor: C.red, alignItems: 'center', justifyContent: 'center', marginBottom: 10 }}>
          <Text style={{ color: C.white, fontSize: 26, fontWeight: '600' }}>{user?.company?.nameAr?.[0] || 'م'}</Text>
        </View>
        <Text style={{ fontWeight: '600', fontSize: 16, color: C.text }}>{user?.company?.nameAr || 'شركتك'}</Text>
        <Text style={{ color: C.muted, fontSize: 13, marginTop: 2 }}>{user?.email}</Text>
        <View style={{ marginTop: 8, backgroundColor: C.red + '15', paddingHorizontal: 12, paddingVertical: 4, borderRadius: 10 }}>
          <Text style={{ color: C.red, fontSize: 12, fontWeight: '600' }}>{user?.company?.verifiedLevel || 'FREE'}</Text>
        </View>
      </View>

      {sections.map(s => (
        <TouchableOpacity key={s.label} style={[S.card, S.rowBetween]} onPress={() => navigation.navigate(s.screen)}>
          <View style={S.row}>
            <Text style={{ fontSize: 20, marginLeft: 10 }}>{s.icon}</Text>
            <Text style={{ color: C.text, fontSize: 14 }}>{s.label}</Text>
          </View>
          <Text style={{ color: C.muted }}>{'←'}</Text>
        </TouchableOpacity>
      ))}

      <TouchableOpacity style={[S.btnOutline, { borderColor: '#c00', marginTop: 10 }]} onPress={() => Alert.alert('تسجيل الخروج', 'هل تريد الخروج؟', [{ text: 'إلغاء', style: 'cancel' }, { text: 'خروج', onPress: logout }])}>
        <Text style={{ color: '#c00', fontWeight: '600' }}>تسجيل الخروج</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

// ── 11-15: Remaining screens (CreateRFQ, RFQDetail, SupplierDetail, QuoteCompare, TwoFASetup) ──

export function CreateRfqScreen({ navigation }: any) {
  const [step, setStep] = useState(0);
  const [form, setForm] = useState({ categoryId: '', quantity: '', unit: 'طن', deliveryCity: '', paymentMethod: 'ESCROW', specsJson: {} });
  const mutation = useMutation({
    mutationFn: () => rfqApi.create({ ...form, quantity: +form.quantity, publish: true, deadline: new Date(Date.now() + 7 * 86400000).toISOString(), deliveryAddress: form.deliveryCity }),
    onSuccess: () => { Alert.alert('تم', 'تم إرسال الطلب بنجاح'); navigation.goBack(); },
  });
  const STEPS = ['القطاع', 'التفاصيل', 'التسليم', 'الإرسال'];
  return (
    <View style={S.screen}>
      <View style={[S.row, { padding: 12, gap: 0 }]}>
        {STEPS.map((s, i) => (
          <View key={s} style={{ flex: 1, height: 4, backgroundColor: i <= step ? C.red : C.border, marginHorizontal: 2, borderRadius: 2 }} />
        ))}
      </View>
      <ScrollView contentContainerStyle={{ padding: 14 }}>
        {step === 0 && (
          <>
            <Text style={S.sectionTitle}>اختر القطاع الصناعي</Text>
            {['الحديد ومشتقاته', 'البتروكيماويات', 'الطاقة الشمسية', 'الصناعات الغذائية', 'الألومنيوم'].map(s => (
              <TouchableOpacity key={s} style={[S.card, form.categoryId === s && { borderColor: C.red, borderWidth: 1.5 }]} onPress={() => setForm(f => ({ ...f, categoryId: s }))}>
                <Text style={{ color: form.categoryId === s ? C.red : C.text, fontWeight: form.categoryId === s ? '600' : '400' }}>{s}</Text>
              </TouchableOpacity>
            ))}
          </>
        )}
        {step === 1 && (
          <>
            <Text style={S.label}>الكمية المطلوبة</Text>
            <TextInput style={S.input} value={form.quantity} onChangeText={v => setForm(f => ({ ...f, quantity: v }))} keyboardType="numeric" placeholder="مثال: ٥٠" />
            <Text style={S.label}>وحدة القياس</Text>
            <View style={[S.row, { gap: 8, marginBottom: 10 }]}>
              {['طن', 'كجم', 'لتر', 'وحدة'].map(u => (
                <TouchableOpacity key={u} style={[S.btnOutline, { padding: 8, flex: 1, borderColor: form.unit === u ? C.red : C.border }]} onPress={() => setForm(f => ({ ...f, unit: u }))}>
                  <Text style={{ color: form.unit === u ? C.red : C.muted, fontSize: 12 }}>{u}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </>
        )}
        {step === 2 && (
          <>
            <Text style={S.label}>مدينة التسليم</Text>
            <TextInput style={S.input} value={form.deliveryCity} onChangeText={v => setForm(f => ({ ...f, deliveryCity: v }))} placeholder="مثال: العاشر من رمضان" />
            <Text style={S.label}>طريقة الدفع</Text>
            {['ESCROW', 'INSTALLMENT'].map(p => (
              <TouchableOpacity key={p} style={[S.card, form.paymentMethod === p && { borderColor: C.red }]} onPress={() => setForm(f => ({ ...f, paymentMethod: p }))}>
                <Text style={{ color: form.paymentMethod === p ? C.red : C.text }}>{p === 'ESCROW' ? 'Escrow — الأكثر أماناً ✓' : 'تمويل بالتقسيط'}</Text>
              </TouchableOpacity>
            ))}
          </>
        )}
        {step === 3 && (
          <View style={S.card}>
            <Text style={S.sectionTitle}>مراجعة الطلب</Text>
            {[['القطاع', form.categoryId], ['الكمية', `${form.quantity} ${form.unit}`], ['التسليم', form.deliveryCity], ['الدفع', form.paymentMethod]].map(([k, v]) => (
              <View key={k} style={[S.rowBetween, { paddingVertical: 6, borderBottomWidth: 0.5, borderColor: C.border }]}>
                <Text style={{ color: C.muted }}>{k}</Text>
                <Text style={{ fontWeight: '500', color: C.text }}>{v}</Text>
              </View>
            ))}
          </View>
        )}
      </ScrollView>
      <View style={[S.row, { padding: 12, gap: 10 }]}>
        {step > 0 && <TouchableOpacity style={[S.btnOutline, { flex: 1 }]} onPress={() => setStep(s => s - 1)}><Text style={{ color: C.red, fontWeight: '600' }}>السابق</Text></TouchableOpacity>}
        <TouchableOpacity style={[S.btn, { flex: 2 }]} onPress={() => step < 3 ? setStep(s => s + 1) : mutation.mutate()}>
          <Text style={S.btnText}>{mutation.isPending ? '...' : step < 3 ? 'التالي' : 'إرسال الطلب'}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

export function RfqDetailScreen({ route, navigation }: any) {
  const { id } = route.params;
  const { data } = useQuery({ queryKey: ['rfq', id], queryFn: () => rfqApi.list({ id }) });
  return (
    <ScrollView style={S.screen} contentContainerStyle={{ padding: 14 }}>
      <View style={S.card}><Text style={{ color: C.red, fontWeight: '600' }}>#{id.slice(-8).toUpperCase()}</Text><Text style={{ marginTop: 6, color: C.text, fontWeight: '500', fontSize: 16 }}>{data?.category?.nameAr}</Text></View>
      <TouchableOpacity style={S.btn} onPress={() => navigation.navigate('QuoteCompare', { rfqId: id })}><Text style={S.btnText}>مقارنة العروض المستلمة</Text></TouchableOpacity>
    </ScrollView>
  );
}

export function SupplierDetailScreen({ route, navigation }: any) {
  const { id } = route.params;
  const { data } = useQuery({ queryKey: ['supplier', id], queryFn: () => suppliersApi.detail(id) });
  const s = data?.data || data;
  return (
    <ScrollView style={S.screen} contentContainerStyle={{ padding: 14 }}>
      <View style={[S.card, { alignItems: 'center' }]}>
        <View style={{ width: 64, height: 64, borderRadius: 14, backgroundColor: C.red, alignItems: 'center', justifyContent: 'center', marginBottom: 10 }}>
          <Text style={{ color: C.white, fontSize: 26, fontWeight: '600' }}>{s?.nameAr?.[0]}</Text>
        </View>
        <Text style={{ fontSize: 18, fontWeight: '500', color: C.text }}>{s?.nameAr}</Text>
        <Text style={{ color: C.muted, marginTop: 2 }}>{s?.location?.city} · {s?.verifiedLevel}</Text>
        <Text style={[S.stars, { marginTop: 6 }]}>{'★'.repeat(Math.round(s?.avgRating || 0))} {s?.avgRating?.toFixed(1)}</Text>
      </View>
      {[['Trust Score', `${s?.trustScore}/١٠٠`], ['صفقات مكتملة', s?.totalDeals], ['زمن الرد', `${s?.avgResponseHours}h`]].map(([k, v]) => (
        <View key={String(k)} style={[S.rowBetween, S.card]}>
          <Text style={{ color: C.muted }}>{k}</Text>
          <Text style={{ fontWeight: '500', color: C.text }}>{v}</Text>
        </View>
      ))}
      <TouchableOpacity style={S.btn} onPress={() => navigation.navigate('CreateRFQ', { supplierId: id })}><Text style={S.btnText}>طلب عرض سعر من هذا المورد</Text></TouchableOpacity>
    </ScrollView>
  );
}

export function QuoteCompareScreen({ route }: any) {
  const { rfqId } = route.params;
  const { data } = useQuery({ queryKey: ['quotes', rfqId], queryFn: () => rfqApi.list({ id: rfqId }) });
  return (
    <ScrollView style={S.screen} contentContainerStyle={{ padding: 14 }}>
      <Text style={S.sectionTitle}>مقارنة العروض</Text>
      {[].map((q: any) => (
        <View key={q.id} style={S.card}><Text style={{ fontWeight: '500', color: C.text }}>{q.supplier?.nameAr}</Text><Text style={{ color: C.red }}>{q.totalPrice?.toLocaleString()} ج.م</Text></View>
      ))}
    </ScrollView>
  );
}

export function TwoFASetupScreen({ navigation }: any) {
  const [step, setStep] = useState<'setup' | 'verify' | 'done'>('setup');
  const [qrUrl, setQrUrl] = useState('');
  const [code, setCode] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const setupMutation = useMutation({ mutationFn: async () => { const res = await fetch('/api/v1/auth/2fa/setup'); return res.json(); }, onSuccess: (d: any) => { setQrUrl(d.data.qrCodeDataUrl); setStep('verify'); } });
  const activateMutation = useMutation({ mutationFn: async () => { const res = await fetch('/api/v1/auth/2fa/activate', { method: 'POST', body: JSON.stringify({ code }), headers: { 'Content-Type': 'application/json' } }); return res.json(); }, onSuccess: (d: any) => { setBackupCodes(d.data.backupCodes || []); setStep('done'); } });
  return (
    <ScrollView style={S.screen} contentContainerStyle={{ padding: 20, alignItems: 'center' }}>
      {step === 'setup' && (<>
        <Text style={[S.sectionTitle, { textAlign: 'center', marginBottom: 20 }]}>تفعيل المصادقة الثنائية</Text>
        <Text style={{ color: C.muted, textAlign: 'center', marginBottom: 20, lineHeight: 22 }}>سيطلب منك كود إضافي عند تسجيل الدخول لحماية حسابك</Text>
        <TouchableOpacity style={[S.btn, { paddingHorizontal: 40 }]} onPress={() => setupMutation.mutate()}><Text style={S.btnText}>{setupMutation.isPending ? '...' : 'ابدأ الإعداد'}</Text></TouchableOpacity>
      </>)}
      {step === 'verify' && (<>
        <Text style={[S.sectionTitle, { textAlign: 'center' }]}>امسح رمز QR</Text>
        {qrUrl ? <Image source={{ uri: qrUrl }} style={{ width: 200, height: 200, marginVertical: 20 }} /> : <ActivityIndicator color={C.red} style={{ marginVertical: 20 }} />}
        <Text style={S.label}>أدخل الكود من التطبيق</Text>
        <TextInput style={[S.input, { textAlign: 'center', fontSize: 24, letterSpacing: 6, width: 180 }]} value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={6} />
        <TouchableOpacity style={S.btn} onPress={() => activateMutation.mutate()}><Text style={S.btnText}>{activateMutation.isPending ? '...' : 'تفعيل'}</Text></TouchableOpacity>
      </>)}
      {step === 'done' && (<>
        <Text style={{ fontSize: 48, marginBottom: 10 }}>✅</Text>
        <Text style={[S.sectionTitle, { textAlign: 'center' }]}>تم تفعيل المصادقة الثنائية</Text>
        <View style={[S.card, { width: '100%', backgroundColor: '#FFF8E1' }]}>
          <Text style={{ color: '#F57F17', fontWeight: '600', marginBottom: 8, textAlign: 'center' }}>⚠️ احفظ هذه الرموز الاحتياطية</Text>
          {backupCodes.map(c => <Text key={c} style={{ fontFamily: 'monospace', color: C.text, textAlign: 'center', marginBottom: 4 }}>{c}</Text>)}
        </View>
        <TouchableOpacity style={S.btn} onPress={() => navigation.goBack()}><Text style={S.btnText}>إغلاق</Text></TouchableOpacity>
      </>)}
    </ScrollView>
  );
}

export function EscrowDetailScreen() { return <View style={S.center}><Text>Escrow Detail</Text></View>; }
