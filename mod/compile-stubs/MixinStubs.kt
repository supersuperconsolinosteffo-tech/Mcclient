package org.spongepowered.asm.mixin

import kotlin.reflect.KClass

@Target(AnnotationTarget.CLASS)
@Retention(AnnotationRetention.RUNTIME)
annotation class Mixin(
    val value: Array<KClass<*>> = [],
    val targets: Array<String> = [],
    val remap: Boolean = true
)
