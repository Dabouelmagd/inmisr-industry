// ─── notifications/email-templates.ts ────────────────────────────
// قوالب البريد الإلكتروني الرسمية — إن مصر للصناعة
// inmisr.net | داتا لايف لخدمات الذكاء الصناعي

const BASE_STYLE = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', Arial, sans-serif; direction: rtl; background: #F5F5F5; }
  .wrapper { max-width: 600px; margin: 40px auto; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,.08); }
  .header { background: #0D0F12; padding: 24px 32px; }
  .logo-text { color: #fff; font-size: 22px; font-weight: 700; }
  .logo-red { color: #D4A017; }
  .domain { color: #666; font-size: 12px; margin-top: 4px; }
  .flag { display: flex; width: 36px; height: 6px; border-radius: 3px; overflow: hidden; margin-top: 8px; }
  .flag-r { flex: 1; background: #D4A017; }
  .flag-w { flex: 1; background: #EEE; }
  .flag-b { flex: 1; background: #222; }
  .body { padding: 32px; }
  h2 { color: #0D0F12; font-size: 20px; margin-bottom: 14px; }
  p { color: #555; font-size: 14px; line-height: 1.8; margin-bottom: 14px; }
  .btn { display: inline-block; background: #D4A017; color: #fff; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: 700; font-size: 15px; margin: 10px 0; }
  .info-box { background: #F8F8F8; border-right: 4px solid #D4A017; border-radius: 8px; padding: 14px 16px; margin: 16px 0; }
  .info-row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #EEE; font-size: 13px; }
  .info-row:last-child { border-bottom: none; }
  .label { color: #888; }
  .value { font-weight: 600; color: #333; }
  .footer { background: #F8F8F8; padding: 20px 32px; text-align: center; border-top: 1px solid #EEE; }
  .footer p { color: #999; font-size: 11px; margin: 0; }
  .footer a { color: #D4A017; text-decoration: none; }
  .warning { background: #FFF8E1; border: 1px solid #F57F17; border-radius: 8px; padding: 12px 16px; font-size: 13px; color: #6D4C00; margin: 16px 0; }
  .success { background: #E8F5E9; border: 1px solid #2E7D32; border-radius: 8px; padding: 12px 16px; font-size: 13px; color: #1B5E20; margin: 16px 0; }
`;

function baseTemplate(content: string): string {
  return `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>${BASE_STYLE}</style>
</head>
<body>
<div class="wrapper">
  <div class="header">
    <div class="logo-text">إن <span class="logo-red">مصر</span> للصناعة</div>
    <div class="domain">inmisr.net | داتا لايف لخدمات الذكاء الصناعي</div>
    <div class="flag"><div class="flag-r"></div><div class="flag-w"></div><div class="flag-b"></div></div>
  </div>
  <div class="body">${content}</div>
  <div class="footer">
    <p>
      © 2026 إن مصر للصناعة — <a href="https://inmisr.net">inmisr.net</a><br>
      داتا لايف لخدمات الذكاء الصناعي | جميع الحقوق محفوظة<br>
      <a href="https://inmisr.net/privacy">سياسة الخصوصية</a> &nbsp;·&nbsp;
      <a href="https://inmisr.net/terms">شروط الاستخدام</a> &nbsp;·&nbsp;
      <a href="https://inmisr.net/unsubscribe">إلغاء الاشتراك</a>
    </p>
  </div>
</div>
</body>
</html>`;
}

// ── WELCOME EMAIL ─────────────────────────────────────────────────
export function welcomeEmail(userName: string, role: 'SUPPLIER' | 'BUYER'): string {
  const roleText = role === 'SUPPLIER' ? 'مورد' : 'مشتري (مصنع)';
  return baseTemplate(`
    <h2>أهلاً وسهلاً في إن مصر للصناعة! 🎉</h2>
    <p>مرحباً <strong>${userName}</strong>،</p>
    <p>يسعدنا انضمامك إلى السوق الصناعي الرقمي الأول في مصر كـ <strong>${roleText}</strong>.</p>
    <p>يمكنك الآن:</p>
    ${role === 'SUPPLIER' ? `
    <div class="info-box">
      <div class="info-row"><span class="label">✅</span><span class="value">إضافة منتجاتك وخدماتك</span></div>
      <div class="info-row"><span class="label">✅</span><span class="value">الرد على طلبات عروض الأسعار (RFQ)</span></div>
      <div class="info-row"><span class="label">✅</span><span class="value">استلام مدفوعاتك بأمان عبر Escrow</span></div>
      <div class="info-row"><span class="label">✅</span><span class="value">بناء سمعتك من خلال التقييمات</span></div>
    </div>
    ` : `
    <div class="info-box">
      <div class="info-row"><span class="label">✅</span><span class="value">البحث عن موردين من 28 قطاعاً</span></div>
      <div class="info-row"><span class="label">✅</span><span class="value">إنشاء طلبات عروض أسعار في دقائق</span></div>
      <div class="info-row"><span class="label">✅</span><span class="value">الدفع الآمن بنظام Escrow</span></div>
      <div class="info-row"><span class="label">✅</span><span class="value">تتبع شحناتك في الوقت الفعلي</span></div>
    </div>
    `}
    <div style="text-align:center;margin-top:24px">
      <a href="https://inmisr.net/dashboard" class="btn">ابدأ الآن</a>
    </div>
    <p style="font-size:12px;color:#999;margin-top:20px">إذا لم تنشئ هذا الحساب، تجاهل هذه الرسالة أو تواصل معنا على <a href="mailto:support@inmisr.net">support@inmisr.net</a></p>
  `);
}

// ── OTP EMAIL ──────────────────────────────────────────────────────
export function otpEmail(code: string, purpose: string): string {
  const purposeText: Record<string, string> = {
    EMAIL_VERIFY: 'تأكيد البريد الإلكتروني',
    LOGIN_OTP: 'تسجيل الدخول',
    PHONE_VERIFY: 'تأكيد رقم الهاتف',
  };
  return baseTemplate(`
    <h2>${purposeText[purpose] || 'التحقق'}</h2>
    <p>استخدمي الكود التالي لإتمام العملية. الكود صالح لـ <strong>١٠ دقائق فقط</strong>.</p>
    <div style="text-align:center;margin:28px 0">
      <div style="display:inline-block;background:#F5F5F5;border:2px dashed #D4A017;border-radius:12px;padding:20px 40px">
        <div style="font-size:36px;font-weight:700;color:#D4A017;letter-spacing:8px">${code}</div>
      </div>
    </div>
    <div class="warning">⚠️ لا تشاركي هذا الكود مع أي شخص. فريق إن مصر للصناعة لن يطلب منك كودك أبداً.</div>
  `);
}

// ── PASSWORD RESET EMAIL ───────────────────────────────────────────
export function passwordResetEmail(resetUrl: string): string {
  return baseTemplate(`
    <h2>إعادة تعيين كلمة المرور</h2>
    <p>تلقينا طلباً لإعادة تعيين كلمة مرور حسابك في إن مصر للصناعة.</p>
    <p>انقري على الزر أدناه لإعادة التعيين. الرابط <strong>صالح لـ ١٥ دقيقة فقط</strong>.</p>
    <div style="text-align:center;margin:28px 0">
      <a href="${resetUrl}" class="btn">إعادة تعيين كلمة المرور</a>
    </div>
    <div class="warning">إذا لم تطلبي ذلك، تجاهلي هذه الرسالة. حسابك آمن ولم يتم تغيير أي شيء.</div>
    <p style="font-size:12px;color:#999">إذا لم يعمل الزر، انسخي الرابط: <br>${resetUrl}</p>
  `);
}

// ── ESCROW FUNDED EMAIL ────────────────────────────────────────────
export function escrowFundedEmail(
  supplierName: string,
  amount: number,
  orderId: string,
): string {
  return baseTemplate(`
    <h2>تم تحميل الـ Escrow — ابدأ التجهيز فوراً 🔒</h2>
    <p>عزيزي <strong>${supplierName}</strong>،</p>
    <p>تم إيداع مبلغ الطلبية في الحساب الضامن (Escrow). يمكنك البدء في تجهيز الطلب الآن.</p>
    <div class="info-box">
      <div class="info-row"><span class="label">رقم الطلبية</span><span class="value">#${orderId.slice(-8).toUpperCase()}</span></div>
      <div class="info-row"><span class="label">المبلغ المحتجز</span><span class="value">${amount.toLocaleString('ar-EG')} ج.م</span></div>
      <div class="info-row"><span class="label">يُفرج تلقائياً بعد</span><span class="value">٧٢ ساعة من الاستلام</span></div>
    </div>
    <div class="success">✅ المبلغ محتجز بالكامل — سيُحوَّل إليك فور تأكيد المشتري استلام الخامات مطابقة للمواصفات.</div>
    <div style="text-align:center;margin-top:24px">
      <a href="https://inmisr.net/orders/${orderId}" class="btn">عرض تفاصيل الطلبية</a>
    </div>
  `);
}

// ── ESCROW RELEASED EMAIL ──────────────────────────────────────────
export function escrowReleasedEmail(
  supplierName: string,
  netAmount: number,
  orderId: string,
): string {
  return baseTemplate(`
    <h2>تم الإفراج عن أموالك! 🎉</h2>
    <p>عزيزي <strong>${supplierName}</strong>،</p>
    <p>تأكد المشتري استلام الخامات بنجاح. سيصلك المبلغ خلال <strong>٢٤ ساعة عمل</strong>.</p>
    <div class="info-box">
      <div class="info-row"><span class="label">رقم الطلبية</span><span class="value">#${orderId.slice(-8).toUpperCase()}</span></div>
      <div class="info-row"><span class="label">صافي المبلغ</span><span class="value" style="color:#2E7D32;font-size:18px">${netAmount.toLocaleString('ar-EG')} ج.م</span></div>
      <div class="info-row"><span class="label">التحويل إلى</span><span class="value">حسابك البنكي المسجل</span></div>
      <div class="info-row"><span class="label">موعد الوصول</span><span class="value">خلال ٢٤ ساعة عمل</span></div>
    </div>
    <div class="success">✅ شكراً لتعاملك الممتاز! ننتظر طلباتك القادمة.</div>
  `);
}

// ── NEW RFQ NOTIFICATION ───────────────────────────────────────────
export function newRfqEmail(
  supplierName: string,
  sector: string,
  quantity: string,
  unit: string,
  city: string,
  rfqId: string,
  expiresHours: number,
): string {
  return baseTemplate(`
    <h2>طلب عرض سعر جديد يناسب منتجاتك 📋</h2>
    <p>عزيزي <strong>${supplierName}</strong>،</p>
    <p>وصل طلب جديد في قطاع <strong>${sector}</strong> يطابق تخصصك.</p>
    <div class="info-box">
      <div class="info-row"><span class="label">القطاع</span><span class="value">${sector}</span></div>
      <div class="info-row"><span class="label">الكمية</span><span class="value">${quantity} ${unit}</span></div>
      <div class="info-row"><span class="label">مدينة التسليم</span><span class="value">${city}</span></div>
      <div class="info-row"><span class="label">ينتهي خلال</span><span class="value" style="color:#D4A017">${expiresHours} ساعة</span></div>
    </div>
    <div style="text-align:center;margin-top:24px">
      <a href="https://inmisr.net/rfq/${rfqId}" class="btn">قدّم عرضك الآن</a>
    </div>
    <p style="font-size:12px;color:#999;margin-top:16px">الموردون الأسرع في الرد يحظون بأفضل فرص القبول.</p>
  `);
}

// Export all templates
export const EmailTemplates = {
  welcome:       welcomeEmail,
  otp:           otpEmail,
  passwordReset: passwordResetEmail,
  escrowFunded:  escrowFundedEmail,
  escrowReleased: escrowReleasedEmail,
  newRfq:        newRfqEmail,
};
