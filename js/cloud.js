import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, setDoc, getDoc, collection, getDocs, deleteDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyACl8TJOP87yHhawZYLebjBsCuVGp6z6bU",
  authDomain: "aether-streaming-a08a5.firebaseapp.com",
  projectId: "aether-streaming-a08a5",
  storageBucket: "aether-streaming-a08a5.firebasestorage.app",
  messagingSenderId: "623384682814",
  appId: "1:623384682814:web:e4e22d95075f2c71aa0c6f"
};

class CloudSync {
  constructor() {
    this.app = initializeApp(firebaseConfig);
    this.auth = getAuth(this.app);
    this.db = getFirestore(this.app);
    this.user = null;
    
    this.authPromise = new Promise((resolve) => {
      onAuthStateChanged(this.auth, (user) => {
        this.user = user;
        if (user) {
          console.log("Cloud Sync: Logged in as", user.email);
        } else {
          console.log("Cloud Sync: Logged out");
        }
        resolve(user);
      });
    });
  }

  async waitForAuth() {
    return this.authPromise;
  }

  isLoggedIn() {
    return this.user !== null;
  }

  async login(email, password) {
    try {
      const credential = await signInWithEmailAndPassword(this.auth, email, password);
      this.user = credential.user;
      return { success: true };
    } catch (error) {
      console.error("Cloud Login Error:", error);
      return { success: false, error: error.message };
    }
  }

  async register(email, password) {
    try {
      const credential = await createUserWithEmailAndPassword(this.auth, email, password);
      this.user = credential.user;
      return { success: true };
    } catch (error) {
      console.error("Cloud Register Error:", error);
      return { success: false, error: error.message };
    }
  }

  async logout() {
    await signOut(this.auth);
    this.user = null;
  }

  // --- SYNC FUNCTIONS (PUSH) ---

  async pushSettings(profileId, settingsData) {
    if (!this.user || this.isPulling || !profileId) return;
    const docRef = doc(this.db, "users", this.user.uid, "profiles", String(profileId), "settings", "data");
    await setDoc(docRef, settingsData, { merge: true }).catch(e => console.error("Cloud Sync settings error", e));
  }

  async pushProfiles(profilesArray) {
    if (!this.user || this.isPulling) return;
    const docRef = doc(this.db, "users", this.user.uid, "data", "profiles");
    await setDoc(docRef, { list: profilesArray }, { merge: true }).catch(e => console.error("Cloud Sync profiles error", e));
  }

  async pushProgress(profileId, progressData) {
    if (!this.user || this.isPulling) return;
    const docRef = doc(this.db, "users", this.user.uid, "profiles", String(profileId), "progress", String(progressData.id));
    await setDoc(docRef, progressData, { merge: true }).catch(e => console.error("Cloud Sync progress error", e));
  }

  async removeProgress(profileId, progressId) {
    if (!this.user || this.isPulling) return;
    const docRef = doc(this.db, "users", this.user.uid, "profiles", String(profileId), "progress", String(progressId));
    await deleteDoc(docRef).catch(e => console.error("Cloud Sync remove progress error", e));
  }

  async pushFavorite(profileId, type, itemData) {
    if (!this.user || this.isPulling) return;
    const itemId = itemData.id || itemData.stream_id || itemData.series_id;
    const docRef = doc(this.db, "users", this.user.uid, "profiles", String(profileId), "favorites", String(itemId));
    // type is 'movie', 'series', or 'live'
    const payload = { ...itemData, _type: type };
    await setDoc(docRef, payload, { merge: true }).catch(e => console.error("Cloud Sync favorite error", e));
  }

  async removeFavorite(profileId, id) {
    if (!this.user) return;
    const docRef = doc(this.db, "users", this.user.uid, "profiles", String(profileId), "favorites", String(id));
    await deleteDoc(docRef).catch(e => console.error("Cloud Sync favorite remove error", e));
  }

  async pushAllLocalDataToCloud(localDbInstance, progressCallback) {
    if (!this.user) return;
    try {
      console.log("Cloud Sync: Pushing all local data to cloud...");
      if(progressCallback) progressCallback("0%");
      // 1. Push Profiles
      const profiles = await localDbInstance.getProfiles();
      if (profiles && profiles.length > 0) {
        await this.pushProfiles(profiles);
        
        let totalTasks = 0;
        let completedTasks = 0;
        const updateProgress = () => {
          completedTasks++;
          if(progressCallback && totalTasks > 0) {
            const pct = Math.floor((completedTasks / totalTasks) * 100);
            progressCallback(`${pct}%`);
          }
        };

        // First, count all tasks to give accurate percentage
        for (const pData of profiles) {
          await localDbInstance.initProfile(pData.id);
          const favs = await localDbInstance.getSetting('favorites') || { live: [], movie: [], series: [] };
          const progress = await localDbInstance.getAll('progress') || [];
          
          totalTasks += 1; // Settings
          totalTasks += (favs.movie || []).length;
          totalTasks += (favs.series || []).length;
          totalTasks += (favs.live || []).length;
          totalTasks += progress.length;
        }

        // Now actually upload
        for (const pData of profiles) {
          await localDbInstance.initProfile(pData.id);
          
          // Push Settings
          const settingsObj = await localDbInstance.getAllSettings();
          await this.pushSettings(pData.id, settingsObj);
          updateProgress();
          
          const favs = await localDbInstance.getSetting('favorites') || { live: [], movie: [], series: [] };
          
          // Push Favorites
          const movies = await localDbInstance.getAll('movies') || [];
          for (const m of movies.filter(x => (favs.movie || []).includes(String(x.stream_id)))) { await this.pushFavorite(pData.id, 'movie', m); updateProgress(); }
          
          const series = await localDbInstance.getAll('series') || [];
          for (const s of series.filter(x => (favs.series || []).includes(String(x.series_id)))) { await this.pushFavorite(pData.id, 'series', s); updateProgress(); }
          
          const live = await localDbInstance.getAll('live_streams') || [];
          for (const l of live.filter(x => (favs.live || []).includes(String(x.stream_id)))) { await this.pushFavorite(pData.id, 'live', l); updateProgress(); }
          
          // Push Progress
          const progress = await localDbInstance.getAll('progress') || [];
          for (const p of progress) { await this.pushProgress(pData.id, p); updateProgress(); }
        }
        
        // Restore master DB
        await localDbInstance.initMaster();
        if(progressCallback) progressCallback("100%");
        console.log("Cloud Sync: Push complete!");
      }
    } catch(e) {
      console.error("Cloud Sync push error:", e);
    }
  }

  // --- SYNC FUNCTIONS (PULL) ---
  
  async pullAllData(localDbInstance) {
    if (!this.user) return;
    this.isPulling = true;
    console.log("Cloud Sync: Pulling data from cloud...");
    try {
      // 1. (Legacy global settings - no longer used, we sync per profile now)      // 2. Pull Profiles
      const profilesRef = doc(this.db, "users", this.user.uid, "data", "profiles");
      const profilesSnap = await getDoc(profilesRef);
      if (profilesSnap.exists() && profilesSnap.data().list) {
        const cloudProfiles = profilesSnap.data().list;
        await localDbInstance.saveProfiles(cloudProfiles);
        
        for (const pData of cloudProfiles) {
          // Temporarily init this profile DB to sync sub-collections
          await localDbInstance.initProfile(pData.id);
          
          // Pull Settings (Credentials)
          const setRef = doc(this.db, "users", this.user.uid, "profiles", String(pData.id), "settings", "data");
          const setSnap = await getDoc(setRef);
          if (setSnap.exists()) {
            const cloudSettings = setSnap.data();
            for (const [key, value] of Object.entries(cloudSettings)) {
               await localDbInstance.saveSetting(key, value);
            }
          }
          
          // Pull Progress
          const progRef = collection(this.db, "users", this.user.uid, "profiles", String(pData.id), "progress");
          const progSnap = await getDocs(progRef);
          for (const progDoc of progSnap.docs) {
            await localDbInstance.saveProgress(progDoc.data().id, progDoc.data().type, progDoc.data().title, progDoc.data().subtitle, progDoc.data().position, progDoc.data().duration, progDoc.data().cover, progDoc.data());
          }

          // Pull Favorites
          const favsSetting = await localDbInstance.getSetting('favorites') || { live: [], movie: [], series: [] };
          if (!Array.isArray(favsSetting.live)) favsSetting.live = [];
          if (!Array.isArray(favsSetting.movie)) favsSetting.movie = [];
          if (!Array.isArray(favsSetting.series)) favsSetting.series = [];

          const favRef = collection(this.db, "users", this.user.uid, "profiles", String(pData.id), "favorites");
          const favSnap = await getDocs(favRef);
          for (const favDoc of favSnap.docs) {
            const fData = favDoc.data();
            const type = fData._type;
            delete fData._type;
            
            const itemId = String(fData.id || fData.stream_id || fData.series_id);
            if (type === 'movie') {
              await localDbInstance.addFavoriteMovie(fData);
              if (itemId && !favsSetting.movie.includes(itemId)) favsSetting.movie.push(itemId);
            } else if (type === 'series') {
              await localDbInstance.addFavoriteSeries(fData);
              if (itemId && !favsSetting.series.includes(itemId)) favsSetting.series.push(itemId);
            } else if (type === 'live') {
              await localDbInstance.addFavoriteLive(fData);
              if (itemId && !favsSetting.live.includes(itemId)) favsSetting.live.push(itemId);
            }
          }
          await localDbInstance.saveSetting('favorites', favsSetting);
          if (window.app) {
            window.app.favorites = favsSetting;
            window.app.dedupCache = null;
          }
        }
      } else {
        // Cloud is empty! Push existing local profiles to cloud.
        const localProfiles = await localDbInstance.getProfiles();
        if (localProfiles && localProfiles.length > 0) {
          console.log("Cloud Sync: Cloud is empty, pushing local profiles up.");
          this.isPulling = false; // allow push
          await this.pushProfiles(localProfiles);
          this.isPulling = true; // reset
        }
      }
      
      // Restore master database state so app.js can fetch the profiles list properly
      await localDbInstance.initMaster();
      
      console.log("Cloud Sync: Pull complete!");
    } catch (e) {
      console.error("Cloud Sync pull error:", e);
    } finally {
      this.isPulling = false;
    }
  }
}

// Export to global scope
window.cloudSync = new CloudSync();
