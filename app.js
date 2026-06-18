const API = "http://localhost:3001";

// Load files
async function loadFiles() {
    const res = await fetch(API + "/files");
    const files = await res.json();

    const list = document.getElementById("fileList");
    list.innerHTML = "";

    files.forEach(file => {
        const li = document.createElement("li");

        if (file.type === "file") {
            const link = document.createElement("a");
            link.href = API + "/download?path=" + file.name;
            link.textContent = file.name;
            link.target = "_blank";

            li.appendChild(link);
        } else {
            li.textContent = "[DIR] " + file.name;
        }

        list.appendChild(li);
    });
}

// Create folder
async function createFolder() {
    const name = document.getElementById("folderName").value;

    await fetch(API + "/folder", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ path: name })
    });

    loadFiles();
}

// Upload file
async function uploadFile() {
    const fileInput = document.getElementById("fileInput");
    const formData = new FormData();

    formData.append("file", fileInput.files[0]);

    await fetch(API + "/upload", {
        method: "POST",
        body: formData
    });

    loadFiles();
}

// Initial load
loadFiles();