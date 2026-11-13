import { realpathSync } from "node:fs";
import { tmpdir as systemTmpdir } from "node:os";
// macOS /var and /tmp are symlinks. Fixtures must supply canonical paths;
// production's no-symlink checks remain unchanged.
export const tmpdir = () => realpathSync(systemTmpdir());
