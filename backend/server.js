const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = Number(process.env.PORT || 5000);
const ADMIN_KEY = process.env.TESTY_ADMIN_KEY;
const FRONTEND_ORIGIN = process.env.TESTY_FRONTEND_ORIGIN || '*';
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined
});

app.use(cors({ origin: FRONTEND_ORIGIN === '*' ? true : FRONTEND_ORIGIN }));
app.use(express.json({ limit: '1mb' }));

const adminRequired = (req, res, next) => {
  const key = req.get('X-Admin-Key') || '';
  if (!ADMIN_KEY || key !== ADMIN_KEY) return res.status(401).json({ error: 'Admin authentication required' });
  next();
};
const makeNumber = prefix => `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const ORDER_STATUSES = ['Pending', 'Confirmed', 'Preparing', 'Ready', 'Out for Delivery', 'Completed', 'Cancelled'];
const RESERVATION_STATUSES = ['Pending', 'Confirmed', 'Rejected', 'Completed'];

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY, name VARCHAR(80) UNIQUE NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS menu_items (
      id SERIAL PRIMARY KEY, name VARCHAR(120) NOT NULL, category VARCHAR(80) NOT NULL,
      description TEXT DEFAULT '', price NUMERIC(10,2) NOT NULL CHECK (price >= 0),
      image TEXT DEFAULT '', status VARCHAR(20) NOT NULL DEFAULT 'Available', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY, order_number VARCHAR(60) UNIQUE NOT NULL, customer_name VARCHAR(100) NOT NULL,
      phone VARCHAR(30) NOT NULL, email VARCHAR(150) DEFAULT '', address TEXT DEFAULT '',
      order_type VARCHAR(20) NOT NULL DEFAULT 'Delivery', payment_method VARCHAR(40) NOT NULL DEFAULT 'Cash on Delivery',
      subtotal NUMERIC(10,2) NOT NULL, delivery_fee NUMERIC(10,2) NOT NULL DEFAULT 0,
      total NUMERIC(10,2) NOT NULL, status VARCHAR(30) NOT NULL DEFAULT 'Pending', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS order_items (
      id SERIAL PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      menu_item_id INTEGER NOT NULL, name VARCHAR(120) NOT NULL, price NUMERIC(10,2) NOT NULL,
      quantity INTEGER NOT NULL CHECK(quantity > 0)
    );
    CREATE TABLE IF NOT EXISTS reservations (
      id SERIAL PRIMARY KEY, booking_number VARCHAR(60) UNIQUE NOT NULL, name VARCHAR(100) NOT NULL,
      phone VARCHAR(30) NOT NULL, date DATE NOT NULL, time TIME NOT NULL,
      guests INTEGER NOT NULL CHECK(guests BETWEEN 1 AND 20), request TEXT DEFAULT '',
      status VARCHAR(20) NOT NULL DEFAULT 'Pending', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS restaurant_settings (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1), restaurant_name VARCHAR(120) NOT NULL DEFAULT 'Testy Restaurant',
      phone VARCHAR(30) DEFAULT '', address TEXT DEFAULT '', opening_time TIME DEFAULT '10:00',
      closing_time TIME DEFAULT '23:00', delivery_fee NUMERIC(10,2) NOT NULL DEFAULT 49,
      free_delivery_above NUMERIC(10,2) NOT NULL DEFAULT 499, minimum_order NUMERIC(10,2) NOT NULL DEFAULT 0,
      is_open BOOLEAN NOT NULL DEFAULT TRUE, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_type VARCHAR(20) NOT NULL DEFAULT 'Delivery';
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_fee NUMERIC(10,2) NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS idx_orders_number ON orders(order_number);
    CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_res_date_time ON reservations(date,time);
    INSERT INTO restaurant_settings(id) VALUES(1) ON CONFLICT (id) DO NOTHING;
    INSERT INTO categories(name,sort_order) VALUES
      ('Pizza',1),('Burger',2),('Pasta',3),('Chicken',4),('Salad',5),('Drinks',6),('Dessert',7)
      ON CONFLICT (name) DO NOTHING;
  `);
}

app.get('/api/health', async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ status: 'ok', service: 'Testy Restaurant API', database: 'postgresql' }); }
  catch { res.status(503).json({ status: 'error', error: 'Database unavailable' }); }
});

app.post('/api/admin/login', (req, res) => {
  const key = (req.body || {}).key || '';
  if (!ADMIN_KEY || key !== ADMIN_KEY) return res.status(401).json({ error: 'Invalid admin credentials' });
  res.json({ success: true });
});

app.get('/api/settings', async (req,res) => {
  try { const { rows } = await pool.query('SELECT restaurant_name,phone,address,opening_time,closing_time,delivery_fee,free_delivery_above,minimum_order,is_open FROM restaurant_settings WHERE id=1'); res.json(rows[0]); }
  catch { res.status(500).json({ error:'Unable to load restaurant settings' }); }
});
app.patch('/api/settings', adminRequired, async (req,res) => {
  const d=req.body||{};
  const fee=Number(d.delivery_fee), free=Number(d.free_delivery_above), min=Number(d.minimum_order);
  if (![fee,free,min].every(Number.isFinite) || fee<0 || free<0 || min<0) return res.status(400).json({error:'Invalid delivery or order settings'});
  try { const {rows}=await pool.query(`UPDATE restaurant_settings SET restaurant_name=$1,phone=$2,address=$3,opening_time=$4,closing_time=$5,delivery_fee=$6,free_delivery_above=$7,minimum_order=$8,is_open=$9,updated_at=NOW() WHERE id=1 RETURNING *`,[d.restaurant_name||'Testy Restaurant',d.phone||'',d.address||'',d.opening_time||'10:00',d.closing_time||'23:00',fee,free,min,Boolean(d.is_open)]); res.json(rows[0]); }
  catch { res.status(500).json({error:'Unable to update settings'}); }
});

app.get('/api/categories', async (req,res) => {
  try { const {rows}=await pool.query('SELECT id,name FROM categories WHERE active=true ORDER BY sort_order,name'); res.json(rows); }
  catch { res.status(500).json({error:'Unable to load categories'}); }
});
app.get('/api/admin/categories', adminRequired, async (req,res) => {
  try { const {rows}=await pool.query('SELECT * FROM categories ORDER BY sort_order,name'); res.json(rows); }
  catch { res.status(500).json({error:'Unable to load categories'}); }
});
app.post('/api/categories', adminRequired, async (req,res) => {
  const name=String(req.body?.name||'').trim();
  if(!name||name.length>80)return res.status(400).json({error:'Category name is required'});
  try { const {rows}=await pool.query('INSERT INTO categories(name,sort_order) VALUES($1,(SELECT COALESCE(MAX(sort_order),0)+1 FROM categories)) RETURNING *',[name]); res.status(201).json(rows[0]); }
  catch(e) { if(e.code==='23505')return res.status(409).json({error:'Category already exists'}); res.status(500).json({error:'Unable to add category'}); }
});
app.patch('/api/categories/:id', adminRequired, async (req,res) => {
  const name=String(req.body?.name||'').trim();
  if(!name||name.length>80)return res.status(400).json({error:'Category name is required'});
  try { const {rows}=await pool.query('UPDATE categories SET name=$1 WHERE id=$2 RETURNING *',[name,Number(req.params.id)]); if(!rows[0])return res.status(404).json({error:'Category not found'}); res.json(rows[0]); }
  catch(e) { if(e.code==='23505')return res.status(409).json({error:'Category already exists'}); res.status(500).json({error:'Unable to update category'}); }
});
app.patch('/api/categories/:id/status', adminRequired, async (req,res) => {
  try { const {rows}=await pool.query('UPDATE categories SET active=$1 WHERE id=$2 RETURNING *',[Boolean(req.body?.active),Number(req.params.id)]); if(!rows[0])return res.status(404).json({error:'Category not found'}); res.json(rows[0]); }
  catch { res.status(500).json({error:'Unable to update category'}); }
});

app.get('/api/menu', async (req,res) => {
  try { const { rows } = await pool.query("SELECT * FROM menu_items WHERE status='Available' ORDER BY category,name"); res.json(rows); }
  catch { res.status(500).json({ error: 'Unable to load menu' }); }
});
app.get('/api/admin/menu', adminRequired, async (req,res) => {
  try { const { rows } = await pool.query('SELECT * FROM menu_items ORDER BY id DESC'); res.json(rows); }
  catch { res.status(500).json({ error: 'Unable to load menu' }); }
});
app.post('/api/menu', adminRequired, async (req,res) => {
  const d=req.body||{}, price=Number(d.price), status=d.status||'Available';
  if(!d.name||!d.category||!Number.isFinite(price)||price<0||!['Available','Unavailable'].includes(status)) return res.status(400).json({error:'Valid name, category, price and status are required'});
  try { const { rows }=await pool.query('INSERT INTO menu_items(name,category,description,price,image,status) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[d.name.trim(),d.category,(d.description||'').trim(),price,d.image||'',status]); res.status(201).json(rows[0]); }
  catch { res.status(500).json({error:'Unable to add menu item'}); }
});
app.patch('/api/menu/:id', adminRequired, async (req,res) => {
  const d=req.body||{}, fields=['name','category','description','price','image','status'].filter(k=>d[k]!==undefined);
  if(!fields.length)return res.status(400).json({error:'No fields to update'});
  if(d.price!==undefined&&(!Number.isFinite(Number(d.price))||Number(d.price)<0))return res.status(400).json({error:'Invalid price'});
  if(d.status!==undefined&&!['Available','Unavailable'].includes(d.status))return res.status(400).json({error:'Invalid status'});
  const values=fields.map(k=>k==='price'?Number(d[k]):d[k]); const sets=fields.map((k,i)=>`${k}=$${i+1}`).join(',');
  try { const {rows}=await pool.query(`UPDATE menu_items SET ${sets} WHERE id=$${fields.length+1} RETURNING *`,[...values,Number(req.params.id)]); if(!rows[0])return res.status(404).json({error:'Menu item not found'}); res.json(rows[0]); }
  catch { res.status(500).json({error:'Unable to update menu item'}); }
});
app.delete('/api/menu/:id', adminRequired, async (req,res) => { try { const r=await pool.query('DELETE FROM menu_items WHERE id=$1',[Number(req.params.id)]); if(!r.rowCount)return res.status(404).json({error:'Menu item not found'}); res.json({success:true}); } catch { res.status(500).json({error:'Unable to delete menu item'}); } });

app.get('/api/orders',adminRequired,async(req,res)=>{try{const {rows}=await pool.query('SELECT * FROM orders ORDER BY id DESC');for(const o of rows){const x=await pool.query('SELECT * FROM order_items WHERE order_id=$1',[o.id]);o.items=x.rows;}res.json(rows);}catch{res.status(500).json({error:'Unable to load orders'});}});
app.get('/api/orders/:number',async(req,res)=>{try{const {rows}=await pool.query('SELECT id,order_number,customer_name,phone,address,order_type,payment_method,subtotal,delivery_fee,total,status,created_at FROM orders WHERE order_number=$1',[req.params.number]);if(!rows[0])return res.status(404).json({error:'Order not found'});const o=rows[0];const x=await pool.query('SELECT name,price,quantity FROM order_items WHERE order_id=$1',[o.id]);o.items=x.rows;delete o.id;res.json(o);}catch{res.status(500).json({error:'Unable to load order'});}});
app.post('/api/orders',async(req,res)=>{const d=req.body||{},c=d.customer||{},items=d.items||[],orderType=d.order_type||'Delivery';if(!c.name||!c.phone||!c.address||!Array.isArray(items)||!items.length||!['Delivery','Pickup'].includes(orderType))return res.status(400).json({error:'Name, phone, address, order type and items are required'});const client=await pool.connect();try{await client.query('BEGIN');const setting=(await client.query('SELECT * FROM restaurant_settings WHERE id=1')).rows[0];if(!setting?.is_open)throw Object.assign(new Error('The restaurant is currently closed'),{status:409});let subtotal=0,valid=[];for(const i of items){const q=Number(i.quantity),id=Number(i.id);if(!Number.isInteger(id)||!Number.isInteger(q)||q<1||q>20)throw Object.assign(new Error('Invalid item quantity'),{status:400});const x=await client.query("SELECT id,name,price,status FROM menu_items WHERE id=$1",[id]);const row=x.rows[0];if(!row||row.status!=='Available')throw Object.assign(new Error(`${row?.name||'Item'} is unavailable`),{status:409});subtotal+=Number(row.price)*q;valid.push([row,q]);}if(subtotal<Number(setting.minimum_order))throw Object.assign(new Error(`Minimum order is ₹${Number(setting.minimum_order).toFixed(2)}`),{status:400});const fee=orderType==='Pickup'?0:(subtotal>=Number(setting.free_delivery_above)?0:Number(setting.delivery_fee));const total=subtotal+fee,number=makeNumber('TR');const order=await client.query('INSERT INTO orders(order_number,customer_name,phone,email,address,order_type,payment_method,subtotal,delivery_fee,total,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id',[number,c.name.trim(),c.phone.trim(),c.email||'',c.address.trim(),orderType,d.payment_method||(orderType==='Pickup'?'Pay at Restaurant':'Cash on Delivery'),subtotal,fee,total,'Pending']);for(const [r,q] of valid)await client.query('INSERT INTO order_items(order_id,menu_item_id,name,price,quantity) VALUES($1,$2,$3,$4,$5)',[order.rows[0].id,r.id,r.name,r.price,q]);await client.query('COMMIT');res.status(201).json({order_number:number,status:'Pending',order_type:orderType,subtotal,delivery_fee:fee,total});}catch(e){await client.query('ROLLBACK');res.status(e.status||500).json({error:e.message||'Unable to place order'});}finally{client.release();}});
app.patch('/api/orders/:id/status',adminRequired,async(req,res)=>{if(!ORDER_STATUSES.includes(req.body?.status))return res.status(400).json({error:'Invalid order status'});try{const r=await pool.query('UPDATE orders SET status=$1 WHERE id=$2 RETURNING status',[req.body.status,Number(req.params.id)]);if(!r.rows[0])return res.status(404).json({error:'Order not found'});res.json({success:true,status:r.rows[0].status});}catch{res.status(500).json({error:'Unable to update order'});}});

app.get('/api/reservations',adminRequired,async(req,res)=>{try{const {rows}=await pool.query('SELECT * FROM reservations ORDER BY date,time');res.json(rows);}catch{res.status(500).json({error:'Unable to load reservations'});}});
app.post('/api/reservations',async(req,res)=>{const d=req.body||{},guests=Number(d.guests);if(!d.name||!d.phone||!d.date||!d.time||!Number.isInteger(guests)||guests<1||guests>20)return res.status(400).json({error:'Valid name, phone, date, time and guests are required'});try{const x=await pool.query("SELECT COALESCE(SUM(guests),0) AS booked FROM reservations WHERE date=$1 AND time=$2 AND status IN ('Pending','Confirmed')",[d.date,d.time]);if(Number(x.rows[0].booked)+guests>40)return res.status(409).json({error:'No tables available at this time'});const number=makeNumber('TB');await pool.query('INSERT INTO reservations(booking_number,name,phone,date,time,guests,request,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[number,d.name.trim(),d.phone.trim(),d.date,d.time,guests,d.request||'','Pending']);res.status(201).json({booking_number:number,status:'Pending'});}catch{res.status(500).json({error:'Unable to create reservation'});}});
app.patch('/api/reservations/:id/status',adminRequired,async(req,res)=>{if(!RESERVATION_STATUSES.includes(req.body?.status))return res.status(400).json({error:'Invalid reservation status'});try{const r=await pool.query('UPDATE reservations SET status=$1 WHERE id=$2 RETURNING status',[req.body.status,Number(req.params.id)]);if(!r.rows[0])return res.status(404).json({error:'Reservation not found'});res.json({success:true,status:r.rows[0].status});}catch{res.status(500).json({error:'Unable to update reservation'});}});

app.use((err,req,res,next)=>{console.error(err);res.status(500).json({error:'Internal server error'});});
initDb().then(()=>app.listen(PORT,()=>console.log(`Testy Restaurant API running on port ${PORT}`))).catch(err=>{console.error('Database initialization failed:',err.message);process.exit(1);});
