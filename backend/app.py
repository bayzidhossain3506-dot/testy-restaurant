from flask import Flask, jsonify, request
from flask_cors import CORS
import sqlite3, os, secrets
from pathlib import Path
from datetime import datetime, timezone

BASE_DIR=Path(__file__).resolve().parent
DB_PATH=Path(os.getenv('TESTY_DB_PATH',BASE_DIR/'testy.db'))
app=Flask(__name__)
CORS(app,origins=os.getenv('TESTY_FRONTEND_ORIGIN','*'))
ADMIN_KEY=os.getenv('TESTY_ADMIN_KEY','change-this-admin-key')

def get_db():
    c=sqlite3.connect(DB_PATH); c.row_factory=sqlite3.Row; return c

def admin_required():
    key=request.headers.get('X-Admin-Key','')
    if not key or not secrets.compare_digest(key,ADMIN_KEY): return jsonify({'error':'Admin authentication required'}),401

def now(): return datetime.now(timezone.utc).isoformat()

def init_db():
    c=get_db(); c.executescript('''CREATE TABLE IF NOT EXISTS menu_items(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,category TEXT NOT NULL,description TEXT DEFAULT '',price REAL NOT NULL,image TEXT DEFAULT '',status TEXT NOT NULL DEFAULT 'Available',created_at TEXT NOT NULL);CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY AUTOINCREMENT,order_number TEXT UNIQUE NOT NULL,customer_name TEXT NOT NULL,phone TEXT NOT NULL,address TEXT DEFAULT '',payment_method TEXT DEFAULT 'Cash on Delivery',subtotal REAL NOT NULL,delivery_fee REAL NOT NULL DEFAULT 0,total REAL NOT NULL,status TEXT NOT NULL DEFAULT 'Pending',created_at TEXT NOT NULL);CREATE TABLE IF NOT EXISTS order_items(id INTEGER PRIMARY KEY AUTOINCREMENT,order_id INTEGER NOT NULL,menu_item_id INTEGER,name TEXT NOT NULL,price REAL NOT NULL,quantity INTEGER NOT NULL,FOREIGN KEY(order_id) REFERENCES orders(id));CREATE TABLE IF NOT EXISTS reservations(id INTEGER PRIMARY KEY AUTOINCREMENT,booking_number TEXT UNIQUE NOT NULL,name TEXT NOT NULL,phone TEXT NOT NULL,date TEXT NOT NULL,time TEXT NOT NULL,guests INTEGER NOT NULL,request TEXT DEFAULT '',status TEXT NOT NULL DEFAULT 'Pending',created_at TEXT NOT NULL);CREATE INDEX IF NOT EXISTS idx_orders_number ON orders(order_number);CREATE INDEX IF NOT EXISTS idx_res_date_time ON reservations(date,time);''');c.commit();c.close()

@app.get('/api/health')
def health(): return jsonify(status='ok',service='Testy Restaurant API')

@app.post('/api/admin/login')
def admin_login():
    key=(request.get_json() or {}).get('key','')
    if not key or not secrets.compare_digest(key,ADMIN_KEY): return jsonify(error='Invalid admin credentials'),401
    return jsonify(success=True,admin_key=key)

@app.get('/api/menu')
def menu():
    c=get_db(); rows=c.execute("SELECT * FROM menu_items WHERE status='Available' ORDER BY category,name").fetchall();c.close();return jsonify([dict(r) for r in rows])

@app.get('/api/admin/menu')
def admin_menu():
    if (e:=admin_required()):return e
    c=get_db();rows=c.execute('SELECT * FROM menu_items ORDER BY id DESC').fetchall();c.close();return jsonify([dict(r) for r in rows])

@app.post('/api/menu')
def create_menu_item():
    if (e:=admin_required()):return e
    d=request.get_json() or {}
    if not d.get('name') or not d.get('category') or d.get('price') is None:return jsonify(error='name, category and price are required'),400
    try:p=float(d['price'])
    except (TypeError,ValueError):return jsonify(error='price must be a number'),400
    if p<0:return jsonify(error='price cannot be negative'),400
    if d.get('status','Available') not in {'Available','Unavailable'}:return jsonify(error='Invalid menu status'),400
    c=get_db();cur=c.execute('INSERT INTO menu_items(name,category,description,price,image,status,created_at) VALUES(?,?,?,?,?,?,?)',(d['name'].strip(),d['category'],d.get('description',''),p,d.get('image',''),d.get('status','Available'),now()));c.commit();r=c.execute('SELECT * FROM menu_items WHERE id=?',(cur.lastrowid,)).fetchone();c.close();return jsonify(dict(r)),201

@app.patch('/api/menu/<int:item_id>')
def update_menu_item(item_id):
    if (e:=admin_required()):return e
    d=request.get_json() or {}; allowed={'name','category','description','price','image','status'};u={k:d[k] for k in allowed if k in d}
    if 'price' in u:
        try:u['price']=float(u['price'])
        except (TypeError,ValueError):return jsonify(error='Invalid price'),400
        if u['price']<0:return jsonify(error='Invalid price'),400
    if 'status' in u and u['status'] not in {'Available','Unavailable'}:return jsonify(error='Invalid status'),400
    if not u:return jsonify(error='no fields to update'),400
    c=get_db();cur=c.execute('UPDATE menu_items SET '+','.join(f'{k}=?' for k in u)+' WHERE id=?',(*u.values(),item_id));c.commit()
    if not cur.rowcount:c.close();return jsonify(error='Menu item not found'),404
    r=c.execute('SELECT * FROM menu_items WHERE id=?',(item_id,)).fetchone();c.close();return jsonify(dict(r))

@app.delete('/api/menu/<int:item_id>')
def delete_menu_item(item_id):
    if (e:=admin_required()):return e
    c=get_db();cur=c.execute('DELETE FROM menu_items WHERE id=?',(item_id,));c.commit();c.close();return (jsonify(success=True),200) if cur.rowcount else (jsonify(error='Menu item not found'),404)

@app.get('/api/orders')
def orders():
    if (e:=admin_required()):return e
    c=get_db();rows=c.execute('SELECT * FROM orders ORDER BY id DESC').fetchall();out=[]
    for r in rows:
        x=dict(r);x['items']=[dict(i) for i in c.execute('SELECT * FROM order_items WHERE order_id=?',(r['id'],)).fetchall()];out.append(x)
    c.close();return jsonify(out)

@app.get('/api/orders/<string:number>')
def get_order(number):
    c=get_db();r=c.execute('SELECT id,order_number,customer_name,subtotal,delivery_fee,total,status,created_at FROM orders WHERE order_number=?',(number,)).fetchone()
    if not r:c.close();return jsonify(error='Order not found'),404
    x=dict(r);x['items']=[dict(i) for i in c.execute('SELECT name,price,quantity FROM order_items WHERE order_id=?',(r['id'],)).fetchall()];c.close();return jsonify(x)

@app.post('/api/orders')
def create_order():
    d=request.get_json() or {};customer=d.get('customer',{});items=d.get('items',[])
    if not customer.get('name') or not customer.get('phone') or not items:return jsonify(error='customer name, phone and items are required'),400
    c=get_db();subtotal=0;valid=[]
    for i in items:
        try:item_id=int(i.get('id'));q=int(i.get('quantity',1))
        except (TypeError,ValueError):c.close();return jsonify(error='Invalid item'),400
        if q<1 or q>20:c.close();return jsonify(error='Quantity must be 1-20'),400
        r=c.execute("SELECT id,name,price,status FROM menu_items WHERE id=?",(item_id,)).fetchone()
        if not r or r['status']!='Available':c.close();return jsonify(error='Item unavailable'),409
        subtotal+=r['price']*q;valid.append((r,q))
    fee=49.0;total=subtotal+fee;number='TR-'+datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S%f')[:17]
    cur=c.execute('INSERT INTO orders(order_number,customer_name,phone,address,payment_method,subtotal,delivery_fee,total,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',(number,customer['name'].strip(),customer['phone'].strip(),customer.get('address',''),d.get('payment_method','Cash on Delivery'),subtotal,fee,total,'Pending',now()))
    for r,q in valid:c.execute('INSERT INTO order_items(order_id,menu_item_id,name,price,quantity) VALUES(?,?,?,?,?)',(cur.lastrowid,r['id'],r['name'],r['price'],q))
    c.commit();c.close();return jsonify(order_number=number,status='Pending',subtotal=subtotal,delivery_fee=fee,total=total),201

@app.patch('/api/orders/<int:order_id>/status')
def update_order_status(order_id):
    if (e:=admin_required()):return e
    s=(request.get_json() or {}).get('status')
    if s not in {'Pending','Confirmed','Preparing','Ready','Completed','Cancelled'}:return jsonify(error='Invalid order status'),400
    c=get_db();cur=c.execute('UPDATE orders SET status=? WHERE id=?',(s,order_id));c.commit();c.close();return (jsonify(success=True,status=s),200) if cur.rowcount else (jsonify(error='Order not found'),404)

@app.get('/api/reservations')
def reservations():
    if (e:=admin_required()):return e
    c=get_db();rows=c.execute('SELECT * FROM reservations ORDER BY date,time').fetchall();c.close();return jsonify([dict(r) for r in rows])

@app.post('/api/reservations')
def create_reservation():
    d=request.get_json() or {}
    if any(not d.get(x) for x in ['name','phone','date','time','guests']):return jsonify(error='name, phone, date, time and guests are required'),400
    try:g=int(d['guests'])
    except (TypeError,ValueError):return jsonify(error='Invalid guests'),400
    if not 1<=g<=20:return jsonify(error='Guests must be 1-20'),400
    c=get_db();conf=c.execute("SELECT COUNT(*) n FROM reservations WHERE date=? AND time=? AND status IN ('Pending','Confirmed')",(d['date'],d['time'])).fetchone()['n']
    if conf>=20:c.close();return jsonify(error='No tables available at this time'),409
    number='TB-'+datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S%f')[:17];c.execute('INSERT INTO reservations(booking_number,name,phone,date,time,guests,request,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)',(number,d['name'].strip(),d['phone'].strip(),d['date'],d['time'],g,d.get('request',''),'Pending',now()));c.commit();c.close();return jsonify(booking_number=number,status='Pending'),201

@app.patch('/api/reservations/<int:reservation_id>/status')
def update_reservation_status(reservation_id):
    if (e:=admin_required()):return e
    s=(request.get_json() or {}).get('status')
    if s not in {'Pending','Confirmed','Rejected','Completed'}:return jsonify(error='Invalid reservation status'),400
    c=get_db();cur=c.execute('UPDATE reservations SET status=? WHERE id=?',(s,reservation_id));c.commit();c.close();return (jsonify(success=True,status=s),200) if cur.rowcount else (jsonify(error='Reservation not found'),404)

init_db()
if __name__=='__main__':app.run(debug=os.getenv('FLASK_DEBUG','0')=='1',port=int(os.getenv('PORT','5000')))
