const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
let Database;
let db;

// محاولة تحميل قاعدة البيانات الحقيقية (لـ Render) أو استخدام ذاكرة مؤقتة (للهاتف)
try {
    Database = require('better-sqlite3');
    db = new Database('./market.db');
    db.pragma('journal_mode = WAL');
    console.log('✅ Using SQLite Database (Production Mode)');
} catch (e) {
    console.log('⚠️ SQLite not found, using Memory Store (Dev Mode)');
    // محاكاة بسيطة لقاعدة البيانات في الذاكرة للهاتف
    db = {
        prepare: (sql) => ({
            run: (...args) => {},
            all: () => [],
            get: () => null
        }),
        exec: () => {}
    };
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// --- تهيئة قاعدة البيانات (إذا كانت SQLite) ---
if (Database) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            vendor_name TEXT, title TEXT, price REAL, city TEXT, image_url TEXT, status TEXT DEFAULT 'approved'
        );
        CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id INTEGER, customer_name TEXT, customer_phone TEXT, customer_city TEXT, address TEXT,
            total_price REAL, delivery_cost REAL DEFAULT 0, status TEXT DEFAULT 'new', driver_id INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS drivers (
            id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, phone TEXT, route_from TEXT, route_to TEXT, is_active BOOLEAN DEFAULT 1
        );
    `);
        // إضافة سائقين افتراضيين إذا لم يوجدوا
    const count = db.prepare("SELECT count(*) as count FROM drivers").get();
    if (count.count === 0) {
        const insert = db.prepare("INSERT INTO drivers (name, phone, route_from, route_to) VALUES (?, ?, ?, ?)");
        insert.run('أحمد طرابلس-مصراتة', '0910000000', 'طرابلس', 'مصراتة');
        insert.run('خالد بنغازي-طرابلس', '0920000000', 'بنغازي', 'طرابلس');
        insert.run('علي مصراتة-طرابلس', '0930000000', 'مصراتة', 'طرابلس');
    }
} else {
    // بيانات وهمية للوضع التجريبي على الهاتف
    global.memoryProducts = [];
    global.memoryOrders = [];
    global.memoryDrivers = [
        { id: 1, name: 'أحمد طرابلس-مصراتة', phone: '0910000000', route_from: 'طرابلس', route_to: 'مصراتة' },
        { id: 2, name: 'خالد بنغازي-طرابلس', phone: '0920000000', route_from: 'بنغازي', route_to: 'طرابلس' }
    ];
}

// --- دوال مساعدة للأتمتة ---

// حساب تكلفة التوصيل التقريبية بين المدن
function calculateDeliveryCost(fromCity, toCity) {
    if (fromCity === toCity) return 10; // داخل المدينة
    const distances = {
        'طرابلس-مصراتة': 30, 'مصراتة-طرابلس': 30,
        'طرابلس-بنغازي': 150, 'بنغازي-طرابلس': 150,
        'بنغازي-مصراتة': 120, 'مصراتة-بنغازي': 120
    };
    const key = `${fromCity}-${toCity}`;
    return distances[key] || 50; // سعر افتراضي
}

// البحث عن سائق مناسب تلقائياً
function findBestDriver(fromCity, toCity) {
    let drivers;
    if (Database) {
        drivers = db.prepare("SELECT * FROM drivers WHERE is_active = 1").all();
    } else {
        drivers = global.memoryDrivers;
    }
    
    // نبحث عن سائق يبدأ من مدينة البائع ويذهب إلى مدينة المشتري
    // أو سائق عام (يمكن تطوير المنطق لاحقاً)
    return drivers.find(d => d.route_from === fromCity && d.route_to === toCity) || drivers[0];
}

// --- APIs ---

// 1. إضافة منتج (نشر فوري - أتمتة)
app.post('/api/product', (req, res) => {    const { vendor_name, title, price, city, image_url } = req.body;
    if (Database) {
        db.prepare("INSERT INTO products (vendor_name, title, price, city, image_url, status) VALUES (?, ?, ?, ?, ?, 'approved')")
          .run(vendor_name, title, price, city, image_url);
    } else {
        global.memoryProducts.push({ ...req.body, id: Date.now(), status: 'approved' });
    }
    res.json({ message: 'تم نشر المنتج فوراً في السوق!' });
});

// 2. جلب المنتجات
app.get('/api/products', (req, res) => {
    let products;
    if (Database) {
        products = db.prepare("SELECT * FROM products WHERE status = 'approved'").all();
    } else {
        products = global.memoryProducts.filter(p => p.status === 'approved');
    }
    res.json(products);
});

// 3. تقديم طلب (مع التعيين التلقائي للسائق)
app.post('/api/order', (req, res) => {
    const { product_id, customer_name, customer_phone, customer_city, address, total_price } = req.body;
    
    // جلب تفاصيل المنتج لمعرفة مدينة البائع
    let product;
    if (Database) {
        product = db.prepare("SELECT * FROM products WHERE id = ?").get(product_id);
    } else {
        product = global.memoryProducts.find(p => p.id == product_id);
    }

    if (!product) return res.status(404).json({ error: 'المنتج غير موجود' });

    const vendorCity = product.city;
    const deliveryCost = calculateDeliveryCost(vendorCity, customer_city);
    const bestDriver = findBestDriver(vendorCity, customer_city);

    let orderId;
    if (Database) {
        const stmt = db.prepare("INSERT INTO orders (product_id, customer_name, customer_phone, customer_city, address, total_price, delivery_cost, driver_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'assigned_driver')");
        const info = stmt.run(product_id, customer_name, customer_phone, customer_city, address, total_price, deliveryCost, bestDriver ? bestDriver.id : null);
        orderId = info.lastInsertRowid;
    } else {
        const newOrder = { 
            ...req.body, id: Date.now(), delivery_cost: deliveryCost, 
            driver_id: bestDriver ? bestDriver.id : null, status: 'assigned_driver' 
        };
        global.memoryOrders.push(newOrder);        orderId = newOrder.id;
    }

    res.json({ 
        message: `تم استلام الطلب وتعيين السائق ${bestDriver ? bestDriver.name : 'غير متوفر'} تلقائياً!`,
        orderId: orderId,
        deliveryCost: deliveryCost
    });
});

// 4. لوحة الإدارة (للمراقبة فقط الآن)
app.get('/api/admin/dashboard', (req, res) => {
    let data = {};
    if (Database) {
        data.pendingProducts = []; // لا يوجد انتظار
        data.newOrders = db.prepare("SELECT o.*, p.title as product_title FROM orders o JOIN products p ON o.product_id = p.id ORDER BY o.created_at DESC LIMIT 10").all();
        data.drivers = db.prepare("SELECT * FROM drivers").all();
    } else {
        data.newOrders = global.memoryOrders.slice(-10);
        data.drivers = global.memoryDrivers;
    }
    res.json(data);
});

// 5. السائق: رؤية طلباته
app.get('/api/driver/orders/:driver_id', (req, res) => {
    let orders;
    if (Database) {
        orders = db.prepare("SELECT o.*, p.title FROM orders o JOIN products p ON o.product_id = p.id WHERE o.driver_id = ? AND o.status != 'delivered'").all(req.params.driver_id);
    } else {
        orders = global.memoryOrders.filter(o => o.driver_id == req.params.driver_id && o.status !== 'delivered');
    }
    res.json(orders);
});

// 6. السائق: تحديث الحالة
app.put('/api/driver/order/:id/status', (req, res) => {
    if (Database) {
        db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(req.body.status, req.params.id);
    } else {
        const order = global.memoryOrders.find(o => o.id == req.params.id);
        if (order) order.status = req.body.status;
    }
    res.json({ message: 'تم التحديث' });
});

app.listen(PORT, () => console.log(`🚀 Auto-Pilot Server running on port ${PORT}`));