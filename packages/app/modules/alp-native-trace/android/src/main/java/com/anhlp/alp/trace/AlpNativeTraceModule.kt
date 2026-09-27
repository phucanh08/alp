package com.anhlp.alp.trace

import android.os.Trace
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class AlpNativeTraceModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("AlpNativeTrace")

    Function("beginSection") { name: String ->
      Trace.beginSection(name.take(127))
    }

    Function("endSection") {
      Trace.endSection()
    }
  }
}
