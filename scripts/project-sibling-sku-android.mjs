/*
 * Filename: project-sibling-sku-android.mjs
 * FullPath: apps/CWSP-shell/scripts/project-sibling-sku-android.mjs
 * FIND:sku
 * Change date and time: 14.05.00_24.08.2026
 * Reason for changes: Explorer/document were manifest-only — clone launcher Gradle so they assemble.
 *
 * Usage:
 *   node scripts/project-sibling-sku-android.mjs explorer|document|process
 *
 * INVARIANT: shared Java stays package space.u2re.cwsp; only applicationId changes.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SHELL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER_ANDROID = path.join(SHELL_ROOT, "platforms/android");

const SKUS = {
    explorer: {
        appRoot: path.resolve(SHELL_ROOT, "../CWSP-explorer"),
        applicationId: "space.u2re.explorer",
        appName: "CWSP Explorer",
        apkStem: "cwsp-explorer",
        sku: "explorer"
    },
    document: {
        appRoot: path.resolve(SHELL_ROOT, "../CWSP-document"),
        applicationId: "space.u2re.document",
        appName: "CWSP Document",
        apkStem: "cwsp-document",
        sku: "document"
    },
    process: {
        appRoot: path.resolve(SHELL_ROOT, "../CWSP-process"),
        applicationId: "space.u2re.process",
        appName: "CWSP Process",
        apkStem: "cwsp-process",
        sku: "process"
    }
};

const COPY_ROOT_FILES = [
    "gradlew",
    "gradlew.bat",
    "gradle.properties",
    "variables.gradle",
    "capacitor.build.gradle",
    "proguard-rules.pro"
];

function copyFile(src, dest) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    if (src.endsWith("gradlew")) fs.chmodSync(dest, 0o755);
}

function copyTree(src, dest, skip = new Set()) {
    if (skip.has(path.basename(src))) return;
    const st = fs.statSync(src);
    if (st.isFile()) {
        copyFile(src, dest);
        return;
    }
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
        if (name === ".git" || name === "node_modules" || name === "build" || name === ".gradle") continue;
        copyTree(path.join(src, name), path.join(dest, name), skip);
    }
}

function posixRel(from, to) {
    const rel = path.relative(from, to).split(path.sep).join("/");
    return rel.startsWith(".") ? rel : `./${rel}`;
}

function writeIfMissing(file, body) {
    if (fs.existsSync(file)) return;
    fs.writeFileSync(file, body);
}

function projectSku(skuName) {
    const spec = SKUS[skuName];
    if (!spec) throw new Error(`unknown sku ${skuName} (explorer|document|process)`);
    const appRoot = fs.realpathSync(spec.appRoot);
    const android = path.join(appRoot, "platforms/android");
    if (!fs.existsSync(LAUNCHER_ANDROID)) {
        throw new Error(`missing launcher android: ${LAUNCHER_ANDROID}`);
    }
    fs.mkdirSync(android, { recursive: true });

    for (const name of COPY_ROOT_FILES) {
        const src = path.join(LAUNCHER_ANDROID, name);
        if (fs.existsSync(src)) copyFile(src, path.join(android, name));
    }
    copyTree(path.join(LAUNCHER_ANDROID, "gradle"), path.join(android, "gradle"));
    copyTree(
        path.join(LAUNCHER_ANDROID, "capacitor-cordova-android-plugins"),
        path.join(android, "capacitor-cordova-android-plugins")
    );

    const launcherRes = path.join(LAUNCHER_ANDROID, "res");
    const skuRes = path.join(android, "res");
    if (fs.existsSync(launcherRes)) {
        for (const name of fs.readdirSync(launcherRes)) {
            if (name.startsWith("mipmap")) continue;
            if (name === "values") {
                for (const valueName of fs.readdirSync(path.join(launcherRes, "values"))) {
                    if (valueName === "strings.xml" || valueName === "ic_launcher_background.xml") continue;
                    copyFile(
                        path.join(launcherRes, "values", valueName),
                        path.join(skuRes, "values", valueName)
                    );
                }
                continue;
            }
            copyTree(path.join(launcherRes, name), path.join(skuRes, name));
        }
        // WHY: SKU splash.xml (solid colorPrimary) + launcher splash.png = duplicate @drawable/splash.
        const splashXml = path.join(skuRes, "drawable", "splash.xml");
        const splashPng = path.join(skuRes, "drawable", "splash.png");
        if (fs.existsSync(splashXml) && fs.existsSync(splashPng)) {
            fs.unlinkSync(splashPng);
        }
    }

    const javaDir = posixRel(android, path.join(SHELL_ROOT, "src/java/space"));
    const capAndroid = posixRel(
        android,
        path.join(SHELL_ROOT, "node_modules/@capacitor/android/capacitor")
    );
    const apkOut = posixRel(android, path.join(appRoot, "build/capacitor/apk"));

    fs.writeFileSync(
        path.join(android, "settings.gradle"),
        `/*
 * Filename: settings.gradle
 * FullPath: ${path.relative(SHELL_ROOT, path.join(android, "settings.gradle"))}
 * FIND:sku
 * Generated by project-sibling-sku-android.mjs — do not hand-merge with launcher.
 */
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.PREFER_SETTINGS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = 'cwsp-${spec.sku}-android'

include ':capacitor-cordova-android-plugins'
project(':capacitor-cordova-android-plugins').projectDir = new File('./capacitor-cordova-android-plugins/')

apply from: 'capacitor.settings.gradle'
`
    );

    fs.writeFileSync(
        path.join(android, "capacitor.settings.gradle"),
        `/*
 * Filename: capacitor.settings.gradle
 * FullPath: platforms/android/capacitor.settings.gradle
 * FIND:sku
 * WHY: sibling SKUs have no @capacitor/android of their own — use CWSP-shell's copy.
 */
def capAndroid = new File(settingsDir, '${capAndroid}').canonicalFile
if (!capAndroid.exists()) {
    throw new GradleException("Unable to find @capacitor/android at \${capAndroid}")
}
include ':capacitor-android'
project(':capacitor-android').projectDir = capAndroid
println "[cwsp-${spec.sku}] capacitor-android → \${capAndroid}"
`
    );

    fs.writeFileSync(
        path.join(android, "build.gradle"),
        `/*
 * Filename: build.gradle
 * FullPath: platforms/android/build.gradle
 * FIND:sku
 * Change date and time: 14.05.00_24.08.2026
 * Reason for changes: ${spec.sku} APK — applicationId ${spec.applicationId}, shared cwsp Java.
 */
plugins {
    id 'com.android.application' version '8.13.0'
}

apply from: 'variables.gradle'

def cwspVersionPropsFile = file("\${rootProject.projectDir}/version.properties")
def cwspVersionProps = new Properties()
if (cwspVersionPropsFile.exists()) {
    cwspVersionPropsFile.withInputStream { cwspVersionProps.load(it) }
}
def cwspVersionCode = (cwspVersionProps.getProperty('VERSION_CODE') ?: '1').toInteger()
def cwspVersionName = cwspVersionProps.getProperty('VERSION_NAME') ?: '0.0.1'

def cwspIdentityPropsFile = file("\${rootProject.projectDir}/cwsp-app-identity.properties")
def cwspIdentityProps = new Properties()
def cwspApkStem = '${spec.apkStem}'
if (cwspIdentityPropsFile.exists()) {
    cwspIdentityPropsFile.withInputStream { cwspIdentityProps.load(it) }
    cwspApkStem = cwspIdentityProps.getProperty('APK_STEM', cwspApkStem)
}

android {
    namespace 'space.u2re.cwsp'
    compileSdk rootProject.ext.compileSdkVersion

    defaultConfig {
        applicationId "${spec.applicationId}"
        minSdkVersion rootProject.ext.minSdkVersion
        targetSdkVersion rootProject.ext.targetSdkVersion
        versionCode cwspVersionCode
        versionName cwspVersionName
        manifestPlaceholders = [cwspAllowCleartext: 'false']
        buildConfigField "boolean", "CWSP_LAUNCHER_SKU", "false"
        buildConfigField "String", "CWSP_SKU", "\\"${spec.sku}\\""
        aaptOptions {
            ignoreAssetsPattern = '!.svn:!.git:!.ds_store:!*.scc:.*:!CVS:!thumbs.db:!picasa.ini:!*~:!*.gz:!*.br'
        }
        buildConfigField "int", "CWSP_VERSION_CODE", "\${cwspVersionCode}"
        buildConfigField "String", "CWSP_VERSION_NAME", "\\"\${cwspVersionName}\\""
    }

    buildFeatures {
        buildConfig true
    }

    compileOptions {
        sourceCompatibility JavaVersion.VERSION_21
        targetCompatibility JavaVersion.VERSION_21
    }

    sourceSets {
        main {
            manifest.srcFile 'AndroidManifest.xml'
            java.srcDirs = ['${javaDir}']
            assets.srcDirs = ['src/main/assets']
            res.srcDirs = ['res']
        }
    }

    buildTypes {
        release {
            minifyEnabled false
            proguardFiles getDefaultProguardFile('proguard-android.txt'), 'proguard-rules.pro'
        }
    }
}

repositories {
    google()
    mavenCentral()
    flatDir {
        dirs 'capacitor-cordova-android-plugins/src/main/libs', 'libs'
    }
}

dependencies {
    implementation "androidx.appcompat:appcompat:\$androidxAppCompatVersion"
    implementation "androidx.coordinatorlayout:coordinatorlayout:\$androidxCoordinatorLayoutVersion"
    implementation "androidx.core:core-splashscreen:\$coreSplashScreenVersion"
    implementation "androidx.core:core:\$androidxCoreVersion"
    implementation project(':capacitor-android')
    implementation project(':capacitor-cordova-android-plugins')
}

apply from: 'capacitor.build.gradle'

def cwspApkPublishRoot = file("\${rootProject.projectDir}/${apkOut}")

tasks.register('copyCwspApks') {
    group = 'distribution'
    doLast {
        def outputsApk = file("\${project.buildDir}/outputs/apk")
        if (!outputsApk.exists()) return
        outputsApk.eachDir { typeDir ->
            def buildType = typeDir.name
            typeDir.eachFileMatch(~/.*\\.apk/) { apk ->
                def typedDir = new File(cwspApkPublishRoot, buildType)
                typedDir.mkdirs()
                ant.copy(file: apk, tofile: new File(typedDir, "\${cwspApkStem}-\${cwspVersionName}.apk"), overwrite: true)
                cwspApkPublishRoot.mkdirs()
                ant.copy(file: apk, tofile: new File(cwspApkPublishRoot, "\${cwspApkStem}-\${cwspVersionName}.apk"), overwrite: true)
            }
        }
    }
}

tasks.configureEach { task ->
    if (task.name ==~ /assemble(Debug|Release)/) {
        task.finalizedBy('copyCwspApks')
    }
}
`
    );

    fs.writeFileSync(
        path.join(android, "cwsp-app-identity.properties"),
        `APP_ID=${spec.applicationId}\nAPP_NAME=${spec.appName}\nAPK_STEM=${spec.apkStem}\n`
    );
    writeIfMissing(
        path.join(android, "version.properties"),
        `# sibling ${spec.sku}\nVERSION_CODE=1\nVERSION_NAME=0.0.1\n`
    );

    const gitignore = path.join(android, ".gitignore");
    if (!fs.existsSync(gitignore)) {
        fs.writeFileSync(gitignore, "build/\n.gradle/\nlocal.properties\nsrc/main/assets/public/\n");
    }

    console.log(`[project-sku] ${spec.sku} android → ${android}`);
    return { appRoot, android, spec };
}

const sku = process.argv[2];
try {
    if (!sku || sku.startsWith("-")) {
        console.error("usage: node project-sibling-sku-android.mjs explorer|document|process");
        process.exit(1);
    }
    projectSku(sku);
} catch (err) {
    console.error("[project-sku]", err?.message || err);
    process.exit(1);
}
