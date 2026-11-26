package net.fabricmc.api

/**
 * Compile-time Fabric Loader API signature descriptor (provided at runtime by Fabric Loader 0.16+).
 * Excluded from the packaged vespera-client runtime JAR just like Gradle `modImplementation`.
 */
fun interface ClientModInitializer {
    fun onInitializeClient()
}

@Target(AnnotationTarget.CLASS, AnnotationTarget.FUNCTION, AnnotationTarget.FIELD)
@Retention(AnnotationRetention.RUNTIME)
annotation class Environment(val value: EnvType)

enum class EnvType {
    CLIENT,
    SERVER
}
