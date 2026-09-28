import util from 'util';
import child_process from "child_process";
import fs from "fs";

/*
    Runs an external command and resolves with its output. Same shape as the promisified
    child_process.execFile, so the real thing can be used as the default and tests can
    inject a fake that records the arguments instead of touching the system.
*/
export type CommandRunner = (file: string, args: string[], options: { timeout: number }) => Promise<{ stdout: string, stderr: string }>;

const defaultCommandRunner: CommandRunner = util.promisify(child_process.execFile);

/*
    The filesystem calls Rbd needs, injectable so tests don't create or remove anything
    under /mnt.
*/
export type FileSystem = {
    mkdirSync(path: string, options: { recursive: true }): unknown;
    rmdirSync(path: string): void;
};

const defaultFileSystem: FileSystem = fs;

export default class Rbd {
    private readonly runner: CommandRunner;
    private readonly fileSystem: FileSystem;

    constructor(
        readonly options: { pool: string, cluster?: string, user?: string, map_options: string[] },
        runner: CommandRunner = defaultCommandRunner,
        fileSystem: FileSystem = defaultFileSystem) {
        this.runner = runner;
        this.fileSystem = fileSystem;
    }

    private commonArgs(): string[] {
        return [
            ...(this.options.cluster ? ["--cluster", this.options.cluster] : []),
            ...(this.options.user ? ["--id", this.options.user] : []),
        ];
    }

    async isMapped(name: string): Promise<string | null> {
        let mapped: { pool: string, name: string, device: string }[];
    
        try {
            const { stdout, stderr } = await this.runner("rbd", [...this.commonArgs(), "showmapped", "--format", "json"], { timeout: 30000 });
            if (stderr) console.log(stderr);
    
            mapped = JSON.parse(stdout);
        }
        catch (error) {
            console.error(error);
            throw new Error(`rbd showmapped command failed with code ${(error as NodeJS.ErrnoException).code}: ${(error as Error).message}`);
        }
    
        const entry = mapped.find(i => i.pool === this.options.pool && i.name === name);

        if (!entry) {
            return null;
        }

        return entry.device;
    }
    
    async map(name: string): Promise<string> {
        try {
            const { stdout, stderr } = await this.runner("rbd", [...this.commonArgs(), "map", ...this.options.map_options, "--pool", this.options.pool, name], { timeout: 30000 });
            if (stderr) console.log(stderr);
    
            return stdout.trim();
        }
        catch (error) {
            console.error(error);
            throw new Error(`rbd map command failed with code ${(error as NodeJS.ErrnoException).code}: ${(error as Error).message}`);
        }
    }
    
    async unMap(name: string): Promise<void> {
        let mustUnmap = await this.isMapped(name);
    
        if (mustUnmap) {
            try {
                const { stdout, stderr } = await this.runner("rbd", [...this.commonArgs(), "unmap", "--pool", this.options.pool, name], { timeout: 30000 });
                if (stderr) console.log(stderr);
                if (stdout) console.log(stdout);
            }
            catch (error) {
                console.error(error);
                throw new Error(`rbd unmap command failed with code ${(error as NodeJS.ErrnoException).code}: ${(error as Error).message}`);
            }
        }
    }

    async list(): Promise<{ image: string, id: string, size: number, format: number }[]> {
        try {
            const { stdout, stderr } = await this.runner("rbd", [...this.commonArgs(), "list", "--pool", this.options.pool, "--long", "--format", "json"], { timeout: 30000 });
            if (stderr) console.log(stderr);
            
            return JSON.parse(stdout);
        }
        catch (error) {
            console.error(error);
            throw new Error(`rbd list command failed with code ${(error as NodeJS.ErrnoException).code}: ${(error as Error).message}`);
        }
    }
    
    async getInfo(name: string): Promise<{ image: string, id: string, size: number, format: number } | undefined> {
        let rbdList = await this.list();
    
        return rbdList.find(i => i.image === name);
    }

    async create(name: string, size: string): Promise<void> {
        try {
            const { stdout, stderr } = await this.runner("rbd", [...this.commonArgs(), "create", "--pool", this.options.pool, name, "--size", size], { timeout: 30000 });
            if (stderr) console.log(stderr);
            if (stdout) console.log(stdout);
        }
        catch (error) {
            console.error(error);
            throw new Error(`rbd create command failed with code ${(error as NodeJS.ErrnoException).code}: ${(error as Error).message}`);
        }
    }

    async makeFilesystem(fstype: string, device: string) {
        try {
            const { stdout, stderr } = await this.runner("mkfs", ["-t", fstype, device], { timeout: 120000 });
            if (stderr) console.error(stderr);
            if (stdout) console.log(stdout);
        }
        catch (error) {
            console.error(error);
            throw Error(`mkfs -t ${fstype} ${device} command failed with code ${(error as NodeJS.ErrnoException).code}: ${(error as Error).message}`);
        }
    }

    async remove(name: string): Promise<void> {
        try {
            const { stdout, stderr } = await this.runner("rbd", [...this.commonArgs(), "trash", "move", "--pool", this.options.pool, name], { timeout: 30000 });
            if (stderr) console.log(stderr);
            if (stdout) console.log(stdout);
        }
        catch (error) {
            console.error(error);
            throw new Error(`rbd remove command failed with code ${(error as NodeJS.ErrnoException).code}: ${(error as Error).message}`);
        }
    }

    async mount(device: string, mountPoint: string): Promise<void> {
        this.fileSystem.mkdirSync(mountPoint, { recursive: true });

        try {
            const { stdout, stderr } = await this.runner("mount", [device, mountPoint], { timeout: 30000 });
            if (stderr) console.error(stderr);
            if (stdout) console.log(stdout);
        }
        catch (error) {
            console.error(error);
            throw new Error(`mount command failed with code ${(error as NodeJS.ErrnoException).code}: ${(error as Error).message}`);
        }
    }

    async unmount(mountPoint: string): Promise<void> {
        try {
            const { stdout, stderr } = await this.runner("umount", [mountPoint], { timeout: 30000 });
            if (stderr) console.error(stderr);
            if (stdout) console.log(stdout);
        }
        catch (error) {
            console.error(error);
            throw new Error(`umount command failed with code ${(error as NodeJS.ErrnoException).code}: ${(error as Error).message}`);
        }

        this.fileSystem.rmdirSync(mountPoint);
    }
}
