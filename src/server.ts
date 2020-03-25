import express from "express";

const app = express();

// Documentation about docker volume plugins can be found here: https://docs.docker.com/engine/extend/plugins_volume/

app.post("/Plugin.Activate", (request, response) => {
    console.log("Activating rbd volume driver");

    response.json({
        "Implements": ["VolumeDriver"]
    });
});


app.post("/VolumeDriver.Create", (request, response) => {
    console.log("Create rbd volume");

    const req = request.body as { Name: string, Opts: { size: string, fstype: string } };

    // rbd create $Name --size $size
    // device = rbd map @Name
    // mkfs.$fstype $device
    // rbd unmap @Name

    response.json({
        Err: ""
    });
});

app.post("/VolumeDriver.Remove", (request, response) => {
    console.log("Removing rbd volume");

    const req = request.body as { Name: string };

    // unmount
    // rbd unmap $Name
    // rbd trash $Name

    response.json({
        Err: ""
    });
});

app.post("/VolumeDriver.Mount", (request, response) => {
    console.log("Mounting rbd volume");

    const req = request.body as { Name: string, ID: string };

    // device = rbd map $Name
    // mount $device /mnt/volumes/$Name

    response.json({
        MountPoint: `/mnt/volumes/${req.Name}`,
        Err: ""
    });
});

app.post("/VolumeDriver.Path", (request, response) => {
    console.log("Request of path of rbd mount");

    const req = request.body as { Name: string };

    // device = rbd map $Name
    // mount $device /mnt/volumes/$Name

    response.json({
        MountPoint: `/mnt/volumes/${req.Name}`,
        Err: ""
    });
});

app.post("/VolumeDriver.Unmount", (request, response) => {
    console.log("Unmounting rbd volume");

    const req = request.body as { Name: string, ID: string };

    // umount /mnt/volumes/$Name
    // rbd unmap $Name

    response.json({
        Err: ""
    });
});

app.post("/VolumeDriver.Get", (request, response) => {
    console.log("Getting info about rbd volume");

    const req = request.body as { Name: string };

    response.json({
        Volume: {
          Name: req.Name,
          Mountpoint: `/mnt/volumes/${req.Name}`,
          Status: {}
        },
        Err: ""
      });
});

app.post("/VolumeDriver.List", (request, response) => {
    console.log("Getting list of registered rbd volumes");

    // rbd list

    response.json({
        Volumes: [
          {
            Name: "",
            Mountpoint: `/mnt/volumes/`
          }
        ],
        Err: ""
      });
});

app.post("/VolumeDriver.Capabilities", (request, response) => {
    console.log("Getting the list of capabilities");

    response.json({
        Capabilities: {
          Scope: "global"
        }
      });
});


// TODO listen on unix socket
app.listen(3000, err => {
    if (err) {
        return console.error(err);
    }

    console.log("Server listening on port 3000");
});