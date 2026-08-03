/*
 * SPDX-License-Identifier: GPL-3.0-only
 */
package io.candlescope.plugin.sdk.v2;

import java.util.ArrayList;
import java.util.List;

/** Fresh-JVM fault entrypoints used only by the Host release gate. */
public final class JvmFaultFixtures {
    private JvmFaultFixtures() {
    }

    public static final class Crash {
        private Crash() {
        }

        public static void main(final String[] arguments) {
            Runtime.getRuntime().halt(23);
        }
    }

    public static final class Hang {
        private Hang() {
        }

        public static void main(final String[] arguments) throws InterruptedException {
            Thread.sleep(60_000L);
        }
    }

    public static final class OutOfMemory {
        private OutOfMemory() {
        }

        public static void main(final String[] arguments) {
            final List<byte[]> retained = new ArrayList<>();
            while (true) {
                retained.add(new byte[4 * 1024 * 1024]);
            }
        }
    }

    public static final class StderrFlood {
        private StderrFlood() {
        }

        public static void main(final String[] arguments) throws Exception {
            final byte[] payload = ("java-stderr-flood-波浪\n").repeat(4096)
                    .getBytes(java.nio.charset.StandardCharsets.UTF_8);
            for (int index = 0; index < 64; index++) {
                System.err.write(payload);
                System.err.flush();
            }
            Thread.sleep(60_000L);
        }
    }
}
