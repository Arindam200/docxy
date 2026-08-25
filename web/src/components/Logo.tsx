import Image from "next/image";
import logoMark from "../../public/logo-mark.png";

/**
 * The mark on its own. It is portrait, so height is the dimension worth setting;
 * width follows from the aspect ratio the static import carries.
 */
export function LogoMark({ className = "h-7" }: { className?: string }) {
  return (
    <Image
      src={logoMark}
      alt=""
      aria-hidden
      priority
      className={`${className} w-auto object-contain`}
    />
  );
}

export function Wordmark({
  href = "#top",
  className = "h-7",
}: {
  href?: string;
  className?: string;
}) {
  return (
    <a href={href} className="flex items-center gap-2">
      <LogoMark className={className} />
      <span className="text-2xl font-semibold text-zinc-900 tracking-tight">
        docxy
      </span>
      <span className="sr-only">Docxy home</span>
    </a>
  );
}
