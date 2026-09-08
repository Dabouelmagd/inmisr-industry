// ─── mobile/src/App.final.tsx ─────────────────────────────────────
// النسخة النهائية من App.tsx — تستخدم الشاشات الحقيقية

import React, { useEffect } from 'react';
import { StatusBar, Platform, LogBox } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import messaging from '@react-native-firebase/messaging';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Import ALL real screens
import {
  HomeScreen, SuppliersScreen, MyRfqsScreen, OrdersScreen, ProfileScreen,
  OrderDetailScreen, ChatScreen, GeoMapScreen, NotificationsScreen, LoyaltyScreen,
  CreateRfqScreen, RfqDetailScreen, SupplierDetailScreen, QuoteCompareScreen,
  TwoFASetupScreen, EscrowDetailScreen,
} from './screens/all-screens';

import { useAuthStore } from './store/auth.store';
import { LoginScreen } from './screens/all-screens'; // LoginScreen also exported

LogBox.ignoreLogs(['Reanimated 2', 'Warning: ...']);

const Stack = createNativeStackNavigator();
const Tab   = createBottomTabNavigator();
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 60000, retry: 2, refetchOnWindowFocus: false } },
});

const NAV_THEME = {
  headerStyle: { backgroundColor: '#0D0D0D' },
  headerTintColor: '#FFFFFF',
  headerTitleStyle: { fontSize: 16, fontWeight: '500' as const },
  headerBackTitle: '',
};

function BuyerTabs() {
  return (
    <Tab.Navigator screenOptions={{ ...NAV_THEME, tabBarActiveTintColor: '#CE1126', tabBarInactiveTintColor: '#888', tabBarStyle: { borderTopWidth: 0.5, borderTopColor: '#E0E0E0' }, tabBarLabelStyle: { fontSize: 11 } }}>
      <Tab.Screen name="Home"      component={HomeScreen}      options={{ title: 'الرئيسية', tabBarLabel: 'الرئيسية' }} />
      <Tab.Screen name="Suppliers" component={SuppliersScreen} options={{ title: 'الموردون',  tabBarLabel: 'الموردون' }} />
      <Tab.Screen name="MyRFQs"   component={MyRfqsScreen}    options={{ title: 'طلباتي',    tabBarLabel: 'طلباتي' }} />
      <Tab.Screen name="Orders"   component={OrdersScreen}    options={{ title: 'الطلبيات',  tabBarLabel: 'الطلبيات' }} />
      <Tab.Screen name="Profile"  component={ProfileScreen}   options={{ title: 'حسابي',     tabBarLabel: 'حسابي' }} />
    </Tab.Navigator>
  );
}

function AuthStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="Login"    component={LoginScreen} />
    </Stack.Navigator>
  );
}

function AppStack() {
  return (
    <Stack.Navigator screenOptions={NAV_THEME}>
      <Stack.Screen name="Main"            component={BuyerTabs}           options={{ headerShown: false }} />
      <Stack.Screen name="SupplierDetail"  component={SupplierDetailScreen} options={{ title: 'ملف المورد' }} />
      <Stack.Screen name="CreateRFQ"       component={CreateRfqScreen}      options={{ title: 'طلب عرض سعر' }} />
      <Stack.Screen name="RFQDetail"       component={RfqDetailScreen}      options={{ title: 'تفاصيل الطلب' }} />
      <Stack.Screen name="OrderDetail"     component={OrderDetailScreen}    options={{ title: 'تفاصيل الطلبية' }} />
      <Stack.Screen name="Chat"            component={ChatScreen}           options={{ title: 'المحادثة الآمنة' }} />
      <Stack.Screen name="QuoteCompare"    component={QuoteCompareScreen}   options={{ title: 'مقارنة العروض' }} />
      <Stack.Screen name="EscrowDetail"    component={EscrowDetailScreen}   options={{ title: 'حالة Escrow' }} />
      <Stack.Screen name="Notifications"   component={NotificationsScreen}  options={{ title: 'الإشعارات' }} />
      <Stack.Screen name="Loyalty"         component={LoyaltyScreen}        options={{ title: 'نقاط الولاء' }} />
      <Stack.Screen name="GeoMap"          component={GeoMapScreen}         options={{ title: 'الخريطة الصناعية' }} />
      <Stack.Screen name="TwoFASetup"      component={TwoFASetupScreen}     options={{ title: 'المصادقة الثنائية' }} />
    </Stack.Navigator>
  );
}

export default function App() {
  const { isAuthenticated, setFcmToken } = useAuthStore();

  useEffect(() => {
    const initPush = async () => {
      const status = await messaging().requestPermission();
      if (status === messaging.AuthorizationStatus.AUTHORIZED ||
          status === messaging.AuthorizationStatus.PROVISIONAL) {
        const token = await messaging().getToken();
        setFcmToken(token);
        await AsyncStorage.setItem('fcm_token', token);
      }
    };
    initPush();

    const unsubFg = messaging().onMessage(async msg => {
      console.log('[FCM FG]', msg.notification?.title);
    });

    messaging().onNotificationOpenedApp(msg => {
      const { orderId, rfqId } = msg.data || {};
      // Deep link navigation would go here
      console.log('[FCM OPEN]', orderId || rfqId);
    });

    return () => { unsubFg(); };
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <NavigationContainer>
        <StatusBar barStyle="light-content" backgroundColor="#0D0D0D" />
        {isAuthenticated ? <AppStack /> : <AuthStack />}
      </NavigationContainer>
    </QueryClientProvider>
  );
}

// ─── src/app.module.complete.ts ───────────────────────────────────
// الـ Module النهائي الكامل بعد إضافة كل الخدمات الناقصة

export const COMPLETE_MODULE_ADDITIONS = `
// أضيفي هذا إلى app.module.final.ts

// New imports
import { FcmService }              from './fcm/fcm.service';
import { FcmController }           from './fcm/fcm.service';
import { AdsService }              from './ads/ads.service';
import { AdsController }           from './ads/ads.service';
import { PriceForecastService }    from './ai/price-forecast.service';
import { PriceForecastController } from './ai/price-forecast.service';
import { ProductsService }         from './products/products.service';
import { ProductsController }      from './products/products.service';
import { ReviewsService }          from './products/products.service';
import { ReviewsController }       from './products/products.service';
import { CategoriesService }       from './products/products.service';
import { CategoriesController }    from './products/products.service';
import { SubscriptionsService }    from './products/products.service';
import { SubscriptionsController } from './products/products.service';
import { SearchController }        from './search/search.controller';
import { MapsController }          from './maps/maps.controller';

// Add to controllers array:
FcmController, AdsController, PriceForecastController,
ProductsController, ReviewsController, CategoriesController,
SubscriptionsController, SearchController, MapsController,

// Add to providers array:
FcmService, AdsService, PriceForecastService,
ProductsService, ReviewsService, CategoriesService, SubscriptionsService,
`;
