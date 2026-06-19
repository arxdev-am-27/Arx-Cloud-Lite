# Arx Cloud Lite

Arx Cloud Lite is a lightweight, self-hosted private cloud storage platform built with Node.js, Express, and SMB-backed storage. It provides a browser-based interface for uploading, downloading, and organizing files on a local or home-lab infrastructure without relying on third-party cloud providers.

This project is designed for personal infrastructure, small teams, and clients who require full control over their data storage environment.

---

## Version

**v1.0.0 - Stable Release**

---

## Key Features

* Password-protected access (single-session secure entry)
* Browser-based file upload and download system
* Folder creation and organization support
* SMB-backed storage integration (local network storage)
* RAID1 redundancy support (external to application layer)
* Offline cold storage backup compatibility
* Lightweight deployment (no external cloud dependencies)
* Clean separation between application logic and storage layer

---

## Architecture Overview

Arx Cloud Lite follows a simple three-layer architecture:

**Frontend**

* Custom HTML/CSS/JavaScript interface
* File management UI
* Direct API communication with backend

**Backend**

* Node.js + Express server
* Handles authentication and file routing
* Controls access to SMB-mounted storage

**Storage Layer**

* SMB-mounted disk (DAS / NAS)
* External to Git repository
* Handles all persistent file storage

---

## Technology Stack

* Node.js
* Express.js
* HTML5 / CSS3 / Vanilla JavaScript
* SMB (Samba) file sharing
* Linux-based hosting environment
* RAID1 + cold storage (infrastructure layer)

---

## Security Model

* Single password authentication (private deployment model)
* Non-destructive file permissions (no delete or rename access via UI)
* Storage isolation outside application repository
* Controlled upload access with restricted file operations

> Note: This system is intended for private or controlled environments. It is not designed as a multi-tenant public SaaS platform.

---

## Storage Design

All user data is stored outside the application repository in a dedicated system path or mounted SMB volume:

```
/ArxStorage/
```

This ensures:

* No user data is committed to Git
* Separation of application and data layers
* Improved security and portability

---

## Use Cases

* Personal cloud storage system
* Home lab file server
* Small business internal file management
* Offline-first storage environments
* Private data hosting with full infrastructure control

---

## Deployment

### Requirements

* Linux server (tested on Ubuntu-based systems)
* Node.js installed
* SMB mount configured
* Local or network-attached storage

### Run Application

```bash
npm install
node server.js
```

Default service runs on configured local port (e.g., 3000/3001).

---

## Project Status

This project is in a stable production baseline state (v1.0.0). Future updates may include:

* Multi-user authentication system
* Role-based access control
* File versioning
* Search and indexing system
* Encrypted file storage layer
* Improved UI/UX enhancements

---

## Author

Arx Tek / Arx Dev
Anderson C. Marcano

Private infrastructure development project focused on self-hosted cloud systems and decentralized data control.

---

## License

Proprietary - All rights reserved (or specify your chosen license)
