import process from "process";

import Rbd from "./rbd";
import { createApp } from "./app";
import { parseConfig } from "./config";

const socketAddress = "/run/docker/plugins/rbd.sock";

const config = parseConfig(process.env);
const rbd = new Rbd(config);

const app = createApp(rbd, config.pool);

app.listen(socketAddress, () => {
    console.log(`Plugin rbd listening on socket ${socketAddress}`);
});
