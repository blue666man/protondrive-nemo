import { Logger, ValidationError } from '@protontech/drive-sdk';

import type { Config } from '../config';
import { Credentials } from './credentials';
import { GpgCredentialsStore } from './gpgCredentialsStore';

export type { Credentials } from './credentials';

/**
 * The only credentials store: the session is kept in a local file encrypted
 * with GnuPG to the recipient key named by `PROTONDRIVE_NEMO_GPG_RECIPIENT`. There
 * is no OS keychain or passphrase fallback.
 */
export function initCredentials(config: Config, logger: Logger): Credentials {
    if (!config.gpgRecipient) {
        throw new ValidationError(
            'PROTONDRIVE_NEMO_GPG_RECIPIENT is not set. It must name the GPG key the stored session is encrypted to (there is no keychain or passphrase fallback).',
        );
    }
    const store = new GpgCredentialsStore(config.credentialsFile, config.gpgRecipient, logger);
    return new Credentials(store, logger);
}
