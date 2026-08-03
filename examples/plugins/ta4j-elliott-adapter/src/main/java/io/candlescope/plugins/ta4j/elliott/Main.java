/*
 * SPDX-License-Identifier: GPL-3.0-only
 */
package io.candlescope.plugins.ta4j.elliott;

import io.candlescope.plugin.sdk.v2.JsonLineServer;

/** Executable JSONL entrypoint. */
public final class Main {
    private Main() {
    }

    public static void main(final String[] arguments) {
        System.exit(JsonLineServer.servePlugin(new Ta4jElliottPlugin()));
    }
}
