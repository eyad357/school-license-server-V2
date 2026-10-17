# خطة نقل السيرفر إلى الإنتاج (خطة فقط — لم يُنفَّذ منها شيء)

**ممنوع تنفيذها قبل قرارك.** ما تحقق محليًا ليس إذنًا بالنشر.

## 0) قبل أي شيء
1. **دوّر الأسرار** الموجودة في `.env` الذي وصلني (JWT_SECRET، كلمة مرور الإدارة/الـ hash، مفاتيح الدفع، رابط القاعدة). اعتبرها مكشوفة.
2. أنشئ بيئة **Staging** في Railway بقاعدة Postgres منفصلة (استعادة نسخة من الإنتاج) — لا تجرِّب على الإنتاج.

## 1) نسخة احتياطية (إلزامية) واختبار استعادتها
```bash
pg_dump "$PROD_DATABASE_URL" -Fc -f prod-$(date +%F-%H%M).dump          # نسخة كاملة
createdb restore_check && pg_restore -d restore_check prod-*.dump         # استعادة في قاعدة منفصلة
```
قارن الأعداد والبصمات (نفس استعلامات `migrate.js`) بين الإنتاج و`restore_check`. **وجود الملف وحده ليس دليلًا**؛ الدليل تطابق البصمات بعد الاستعادة. (جُرِّب هذا محليًا بنجاح.)

## 2) تجربة جافة ثم تطبيق (على Staging أولًا، ثم الإنتاج)
```bash
export DATABASE_URL=...     # Staging
npm run migrate:plan                          # لا يحفظ شيئًا
for f in 003_payment_orders 004_customer_management 005_products_platform 006_events_audit; do
  node scripts/migrate.js --plan  src/db/$f.sql
done
for f in ...same...; do node scripts/migrate.js --apply src/db/$f.sql; done
```
المشغّل: معاملة واحدة لكل ملف، يرفض أي `DROP/TRUNCATE/DELETE`، يقارن بصمات licenses/devices/activations/products قبل/بعد ويتراجع تلقائيًا عند أي فرق، ويرفض أرقام عملاء مكررة. **تجاهل 002 إن كان جدول customers موجودًا أصلًا.**

## 3) النشر المرحلي
1. انشر الكود الجديد على Staging واختبر عميلك الحالي (تفعيل/تحقق/إلغاء) يدويًا.
2. على الإنتاج: النسخة الاحتياطية ← الترحيلات (الكود القديم يعمل عليها كما هي) ← انشر الكود الجديد.
3. راقب `/health` والسجلات ساعة. افحص أن عدد الأجهزة المفعّلة لم ينقص.
4. **لا تفعّل التوقيع** إلا بعد استقرار الأسبوع الأول (07).

## 4) الرجوع
- مشكلة في الكود: أعد نشر النسخة السابقة من Railway. **لا حاجة لمس القاعدة** (الترحيلات إضافية).
- فشل ترحيل: يتراجع وحده.
- تلف بيانات: لا تكتب فوق الإنتاج؛ استعد النسخة في خدمة Postgres جديدة، تحقق، ثم بدّل `DATABASE_URL`. (تفاصيل: `docs/ROLLBACK.md`.)

## 5) إعدادات Railway للبث
- خدمة واحدة تكفي؛ لعدة نسخ (replicas) يعمل `LISTEN/NOTIFY` عبر Postgres دون Redis (مُختبَر بعمليتين).
- تأكد أن اتصالات `LISTEN` تذهب لـ Postgres **مباشرة** (ليس عبر pooler من نوع transaction-mode مثل PgBouncer)، وإلا يسقط إلى الاستطلاع كل 5 ث (يعمل لكن أبطأ).
- مهلة خمول بروكسي Railway غير معروفة لي؛ نبضة السيرفر كل 25 ث، وعميل Windows يعيد الاتصال إن صمت 90 ث. **اختبرها على Staging.**

## متغيرات البيئة
| المتغير | الحالة | ملاحظة |
|---|---|---|
| `DATABASE_URL`, `JWT_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`, `PORT` | قديمة | بلا تغيير |
| `PADDLE_*`, `MYFATOORAH_*` | قديمة | اختيارية |
| `API_RATE_LIMIT_MAX` | موجودة | الافتراضي 100/دقيقة/IP |
| `LICENSE_SIGNING_PRIVATE_KEY`, `LICENSE_SIGNING_KEY_ID` | جديدة (اختيارية) | انظر 07 |
| `LICENSE_EVENTS_HEARTBEAT_MS` (25000), `_MAX_AGE_MS` (1800000), `_POLL_MS` (5000), `_MAX_CONNECTIONS` (5000), `_REPLAY_LIMIT` (50), `_RETENTION_DAYS` (30), `_RETRY_MS` (30000) | جديدة | افتراضيات آمنة |
| `DB_POOL_MAX` (20), `DB_CONNECT_TIMEOUT_MS` (10000) | جديدة | منع التعلّق |
| `LOGIN_RATE_LIMIT_MAX` (10) | جديدة | محاولات دخول فاشلة/15 دقيقة |
| `TEST_DATABASE_URL`, `ALLOW_REMOTE_TEST_DB` | اختبار فقط | **لا تضعها في Railway** |

## قائمة التحقق قبل النشر
- [ ] تدوير الأسرار · [ ] نسخة احتياطية + استعادة مثبتة · [ ] `migrate:plan` على نسخة الإنتاج · [ ] Staging ناجح مع عميلك الحالي · [ ] اختبار Windows حقيقي (09) · [ ] قرارك الكتابي.
