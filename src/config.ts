/*
    The configuration the plugin is started with. The fields match the options Rbd's
    constructor expects.
*/
export type Config = {
    pool: string,
    cluster?: string,
    user?: string,
    map_options: string[]
};

/*
    Reads the plugin configuration from the environment. Pure: it only looks at the
    values passed in, so tests can pass any environment.
*/
export function parseConfig(env: NodeJS.ProcessEnv): Config {
    const pool = env.RBD_CONF_POOL || "rbd";
    const cluster = env.RBD_CONF_CLUSTER || undefined;
    const user = env.RBD_CONF_KEYRING_USER || undefined;
    const map_options = env.RBD_CONF_MAP_OPTIONS !== undefined
        ? env.RBD_CONF_MAP_OPTIONS.split(';').filter(option => option.length > 0) // explicitly set (possibly empty) overrides the default
        : ["--exclusive"]; // default to an exclusive lock when mapping to prevent multiple containers attempting to mount the block device

    return { pool: pool, cluster: cluster, user: user, map_options: map_options };
}
