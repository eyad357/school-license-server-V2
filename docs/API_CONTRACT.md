# عقد الـAPI بين السيرفر وعميل Windows (قديم / جديد)

لم يتغير أي مسار أو اسم حقل أو قيمة `status` أو كود HTTP في مسارات العميل. التغيير الوحيد: حقل اختياري جديد `signedLicense` يُضاف فقط حين يُضبط مفتاح التوقيع على السيرفر.

| المسار (POST /api/v1/licenses/…) | الطلب | النجاح | الفشل |
|---|---|---|---|
| `/activate` | `{licenseKey, deviceId, productId?}` (`productId` الافتراضي `school-accreditation`) | **HTTP 400** + `{status:"active", message, expiresAt, activationRef, signedLicense?}` | HTTP 400 + `status`: `invalid` / `revoked` / `expired` / `device_limit_reached` |
| `/validate` | نفسه | **HTTP 400** + `{status:"active", …}` | `invalid` (غير مفعّل على هذا الجهاز / مفتاح غير موجود / برنامج مختلف) · `revoked` · `expired` |
| `/deactivate` | نفسه | **HTTP 400** + `{status:"deactivated", activationRef}` | `invalid` |
| أي مسار | خطأ داخلي | HTTP 500 + `{status:"SERVER_ERROR"}` | |
| تجاوز الحد (100/دقيقة/IP) | | | HTTP 429 نص عادي (ليس JSON) |

## ملاحظة `ACTIVE` مقابل `active` وHTTP 400 (محسومة بالتجربة)
- المسارات تقارن بحرف كبير (`'ACTIVE'`) بينما الخدمة تُرجع حرفًا صغيرًا (`'active'`) فيخرج النجاح بكود **400** مع جسم صحيح.
- عميل Windows (`electron/license/service.js`) يُطبّع `status` من الجسم ويقدّمه على كود HTTP، فلا يتأثر. **أُثبت ذلك بتشغيل العميل الفعلي** (اختبارات `C5`, `W1`, `O11`).
- **لم أغيّر هذا السلوك** لأن إصلاحه (إرجاع 200) قد يكسر أي عميل مبيع يعتمد على الكود. الإصلاح الآمن مؤجل لإصدار منفصل بعد التأكد من كل الإصدارات المبيعة.

## الحقل الجديد `signedLicense` (إضافي)
```
{ alg:"Ed25519", kid, payload:<base64url JSON>, signature:<base64url> }
payload = { v:1, typ:"license", productId, licenseKey, deviceId, status:"active", expiresAt|null, activationRef, issuedAt }
```
العملاء القدامى يتجاهلونه (أُثبت: H1 مع النسخة الأصلية من Windows).

## لوحة الإدارة (جديد/معدّل)
`/admin/products` (GET/POST/PATCH)، و`productId` إلزامي في إنشاء التراخيص، و`license-records?productId=` ، وعمود `product_name`/`product_id` في صفوف السجلات والتصدير. بقية مسارات الإدارة كما هي.
