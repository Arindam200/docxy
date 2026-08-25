import { Banner, Navbar } from "@/components/Navbar";
import { Hero } from "@/components/Hero";
import {
  Quote,
  Why,
  HowItWorks,
  Roster,
  Integrations,
} from "@/components/Sections";
import { Approval } from "@/components/Approval";
import { Setup, Cost } from "@/components/Setup";
import { Faq } from "@/components/Faq";
import { Footer } from "@/components/Footer";
import { SideRails } from "@/components/primitives";

export default function Home() {
  return (
    <div id="top" className="bg-white">
      <Banner />
      <Navbar />

      <div className="relative">
        <SideRails />

        <Hero />
        <Quote />
        <Why />
        <HowItWorks />
        <Roster />
        <Approval />
        <Integrations />
        <Setup />
        <Cost />
        <Faq />
        <Footer />
      </div>
    </div>
  );
}
