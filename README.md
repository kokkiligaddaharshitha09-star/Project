# RoadAid – On-Road Vehicle Breakdown Assistance Finder

A full-stack vehicle breakdown assistance app with Driver, Mechanic and Admin roles.

## Stack
React 18 + Vite, Node.js + Express, MySQL (`mysql2`), JWT, bcryptjs, Socket.IO, Leaflet.

## Requirements
- Node.js 18+
- MySQL 8+

## Setup

### 1. Database
Create a MySQL user/database is not required manually: the backend creates the `breakdown` database and tables on startup. Configure a MySQL account that can create databases.

### 2. Backend
```bash
cd backend
copy .env.example .env
```
Edit `.env` with your MySQL username/password and a long random `JWT_SECRET`.

```bash
npm install
npm run dev
```
API runs at `http://localhost:5000`.

### 3. Frontend
Open another terminal:
```bash
cd frontend
npm install
npm run dev
```
Open the Vite URL shown in the terminal (normally `http://localhost:5173`).

## First admin account
For safety, create an admin manually after the first backend startup. Generate a bcrypt hash with:
```bash
node -e "require('bcryptjs').hash('ChangeThisPassword123', 10).then(console.log)"
```
Then run this SQL in MySQL:
```sql
USE breakdown;
INSERT INTO users(name, phone, email, password, role, services, lng, lat, available)
VALUES ('RoadAid Admin', '9999999999', 'admin@roadaid.local', 'PASTE_BCRYPT_HASH_HERE',
        'admin', '', 80.64, 16.50, 0);
```
Change the example password immediately.

## Notes
- Browser geolocation requires localhost or HTTPS and user permission.
- Fare values are illustrative estimates, not guaranteed quotations.
- This is a student/demo project. Add HTTPS, phone verification, rate limiting, logging and production secrets before public deployment.
- Never commit `.env`, real passwords, API keys or personal data.
