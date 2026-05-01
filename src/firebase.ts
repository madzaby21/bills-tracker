import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyAsuNCCxrd3WHlcR6IZBPREC6Lb5v_WFAs",
  authDomain: "bills-tracker-a87c4.firebaseapp.com",
  projectId: "bills-tracker-a87c4",
  storageBucket: "bills-tracker-a87c4.firebasestorage.app",
  messagingSenderId: "183149676345",
  appId: "1:183149676345:web:4a96980a0599f642830ae8"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
